const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const requireActiveSub = require("../middleware/requireSub");
const { enqueueCompress } = require("../videoCompress");
const { enqueueThumb } = require("../videoThumb");
const { enqueueImageCompress } = require("../imageCompress");
const { validatePlayerVideo } = require("../videoValidate");
const { validateReceipt } = require("../receiptValidate");
const { registerQuota, chargeUpload } = require("../uploadQuota");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Whitelist of accepted MIME types (rejects HTML/JS/EXE... preventing
// stored XSS through /uploads/ and malware uploads). Mobile phones commonly
// produce MOV (iOS), 3GP/M4V (Android) and MKV — all included here.
const ALLOWED_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/3gpp": ".3gp",
  "video/3gpp2": ".3g2",
  "video/x-m4v": ".m4v"
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
    const ext = ALLOWED_MIME[file.mimetype] || "";
    const base = safe.replace(/\.[^.]*$/, "");
    // PRIVACY: 8 random hex chars make filenames unguessable — pre-signup
    // documents (birth certificates, medical reports) sit in /uploads until
    // the registration is submitted, and sequential names were enumerable.
    cb(null, Date.now() + "_" + db.nextId("upload") + "_" + crypto.randomBytes(4).toString("hex") + "_" + base + ext);
  }
});

const upload = multer({
  storage,
  // 230MB cap per file — the local-disk allowance. Videos larger than the
  // Cloudinary free-plan cap (10MB) stay on this server, so no cloud limit
  // applies. At phone bitrates 230MB is ~20+ minutes.
  limits: { fileSize: 230 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) {
      const err = new Error("File type not allowed: " + file.mimetype);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

const MAX_DOC_BYTES = 10 * 1024 * 1024; // documents / photos: 10MB
const MAX_VIDEO_BYTES = 230 * 1024 * 1024; // videos: 230MB (local disk; the Cloudinary free-plan hard cap is 10MB per file — videos above that stay local permanently)
const isVideo = (f) => f.mimetype && f.mimetype.startsWith("video/");

function makeRecord(f, uploadedBy) {
  return {
    id: "up_" + db.nextId("upload"),
    url: "/uploads/" + f.filename,
    name: f.originalname,
    size: f.size,
    mimetype: f.mimetype,
    uploadedBy,
    createdAt: new Date().toISOString()
  };
}

// The deterministic auto-generated poster/thumbnail for a video (FFmpeg frame
// written by videoThumb.js as <video-basename>.jpg right next to the video).
function localPosterUrl(filePath) {
  return filePath.replace(/\.[^/.]+$/, "") + ".jpg";
}

// Remove the poster .jpg that sits next to a video file (if one exists). The
// orphan sweep / cleanupFiles / cloud promotion must all remove it together
// with the video, otherwise orphaned .jpg files accumulate on disk forever.
function unlinkCompanionThumb(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(localPosterUrl(filePath)); } catch (e) {}
}

function cleanupFiles(list) {
  (list || []).forEach((f) => {
    const full = path.join(UPLOAD_DIR, f.filename);
    try { fs.unlinkSync(full); } catch (e) {}
    if (f.mimetype && f.mimetype.startsWith("video/")) unlinkCompanionThumb(full);
  });
}

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// Videos up to 10MB are still useful on Cloudinary (CDN delivery, works on
// mobile data) — the free-plan per-file limit. Larger videos can NEVER live
// there (verified live: chunked or not, any upload declaring >10MB total is
// rejected), so they stay on the local disk permanently. The HTTP response
// never blocks on the cloud hop: the record is stored/returned immediately
// with the local URL; a ≤10MB video is promoted to Cloudinary in the
// BACKGROUND (once the push succeeds the record switches to the CDN URL and
// the local copy is removed). If the push fails the local file stays and
// gets the usual thumbnail/compression pipeline.
const CLOUD_VIDEO_MAX_BYTES = 10 * 1024 * 1024; // free-plan hard cap (10485760)
function uploadVideoToCloud(filePath) {
  return new Promise((resolve) => {
    if (!cloudinaryConfigured()) return resolve(null);
    const publicId = "manara/registrations/" + crypto.randomUUID();
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "video", public_id: publicId, overwrite: false, timeout: 300000 },
      (err, result) => resolve(err || !result ? null : result)
    );
    fs.createReadStream(filePath).on("error", () => resolve(null)).pipe(stream);
  });
}

// Recursively rewrite any string equal to oldUrl with newUrl inside a document
// (handles nested objects/arrays like player.videos / documents / photo).
function rewriteUrlInDoc(doc, oldUrl, newUrl) {
  if (!doc || typeof doc !== "object") return false;
  let changed = false;
  if (Array.isArray(doc)) {
    doc.forEach((item) => { if (rewriteUrlInDoc(item, oldUrl, newUrl)) changed = true; });
    return changed;
  }
  Object.keys(doc).forEach((k) => {
    const v = doc[k];
    if (typeof v === "string") {
      if (v === oldUrl) { doc[k] = newUrl; changed = true; }
    } else if (v && typeof v === "object") {
      if (rewriteUrlInDoc(v, oldUrl, newUrl)) changed = true;
    }
  });
  return changed;
}

// After a video is promoted to Cloudinary the local file is deleted, so every
// document that referenced the old /uploads/ URL must be updated to the CDN
// URL — otherwise the profile keeps a dead link and the video vanishes.
function rewriteReferencesToCloud(store, oldUrl, newUrl) {
  if (!store || !oldUrl || !newUrl || oldUrl === newUrl) return;
  ["users", "players", "clubs", "registrations", "transactions", "ai_chats", "messages", "applications"]
    .forEach((col) => (store[col] || []).forEach((doc) => rewriteUrlInDoc(doc, oldUrl, newUrl)));
}

function promoteToCloudLater(record, localPath) {
  setImmediate(async () => {
    try {
      const res = await uploadVideoToCloud(localPath);
      if (!res || !res.secure_url) {
        console.warn("⚠️ Cloudinary (background) failed — keeping local copy:", record.url);
        // File stays local -> give it the usual local-video pipeline.
        enqueueThumb(localPath);
        enqueueCompress(localPath);
        return;
      }
      const rec = db.get().uploads.find((u) => u.id === record.id);
      const oldUrl = rec ? rec.url : record.url;
      if (rec) {
        rec.url = res.secure_url;
        rec.publicId = res.public_id;
        rec.provider = "cloudinary";
        // Cloudinary auto-generates a video frame for the same public_id with
        // a .jpg extension — reuse the deterministic poster convention so the
        // frontend's <video poster> keeps working after promotion.
        rec.poster = res.secure_url.replace(/\.[^/.]+$/, "") + ".jpg";
        // Keep the pre-promotion local URL. The sign-up client still holds it
        // (it received it from /register-upload) and may POST /api/auth/register
        // while this background push is in flight — without `localUrl` the
        // mediaGuard check would see neither the deleted local file nor a
        // matching record url and reject a perfectly good sign-up as forged.
        rec.localUrl = oldUrl;
      }
      // Keep every consumer (player.videos, registration.videos, ...) pointed
      // at a live URL now that the local file is about to be removed.
      rewriteReferencesToCloud(db.get(), oldUrl, res.secure_url);
      db.save();
      try { fs.unlinkSync(localPath); } catch (e) {}
      // Delete the local poster too, or a discarded <video>.jpg is left behind.
      unlinkCompanionThumb(localPath);
      console.log("☁️ video promoted to Cloudinary:", res.secure_url);
    } catch (e) {
      console.warn("⚠️ Cloudinary (background) error:", e && e.message);
      enqueueThumb(localPath);
      enqueueCompress(localPath);
    }
  });
}

// Builds the stored record for an uploaded file. A ≤10MB video is scheduled
// for Cloudinary promotion in the background (never blocking the response);
// every larger video — which the free plan can never accept — stays on local
// disk and immediately gets the local thumbnail + compression pipeline.
// Every other file type stays on local disk as before.
function finalizeFileRecord(f, uploadedBy) {
  const record = makeRecord(f, uploadedBy);
  if (!isVideo(f)) return record;
  const localPath = path.join(UPLOAD_DIR, f.filename);
  // Store the deterministic local poster URL on the record (a <video>.jpg the
  // thumbnail job will write next to the file). For ≤10MB videos destined for
  // Cloudinary the promotion handler replaces this with the CDN poster.
  record.poster = localPosterUrl(localPath);
  if (cloudinaryConfigured() && f.size <= CLOUD_VIDEO_MAX_BYTES) {
    promoteToCloudLater(record, localPath);
    return record;
  }
  enqueueThumb(localPath);
  enqueueCompress(localPath);
  return record;
}

// POST /api/upload  (multipart, field name "file" or "files") — auth required
// Paywall gate: a lapsed account may NOT upload profile media, BUT it must
// still be able to upload its PAYMENT RECEIPT (purpose "payment_receipt") so
// the user can re-subscribe. Access is only granted after the receipt is
// verified, so exempting this one purpose is safe.
router.post("/", requireAuth, upload.array("file", 10), (req, res, next) => {
  if (req.body && req.body.purpose === "payment_receipt") return next();
  return requireActiveSub(req, res, next);
}, async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: "No file provided (use field name 'file')" });
  }
  const purpose = String((req.body && req.body.purpose) || "");
  const records = [];
  // A saturated ffmpeg pool is a SERVER problem, not a bad file: answer 503
  // (retryable) instead of 400 so the client retries instead of showing the
  // player "your video is invalid".
  const failValidation = (vr) => {
    cleanupFiles(req.files);
    if (vr && vr.code === "busy") {
      return res.status(503).json({ error: vr.message, code: vr.code });
    }
    return res.status(400).json({ error: vr.message, code: vr.code });
  };
  const fail = (message) => {
    cleanupFiles(req.files);
    return res.status(400).json({ error: message });
  };

  const nextFile = async (i) => {
    if (i >= req.files.length) {
      db.get().uploads.push(...records);
      db.save();
      // Background processing only applies to files that stay on local disk.
      // Videos are handled by finalizeFileRecord (local pipeline for >10MB,
      // thumbnail/compress only if the cloud push fails for ≤10MB), so they
      // are skipped here.
      req.files.forEach((f, idx) => {
        if (isVideo(f)) return;
        const localPath = path.join(UPLOAD_DIR, f.filename);
        if (f.mimetype && f.mimetype.startsWith("image/") && purpose !== "payment_receipt") {
          // Photos get compressed in the background. Receipts are NEVER touched:
          // pixel forensics must stay intact for the anti-tamper checks.
          enqueueImageCompress(localPath, f.mimetype);
        }
      });
      return res.status(201).json({ files: records });
    }
    const f = req.files[i];
    if (isVideo(f)) {
      if (f.size > MAX_VIDEO_BYTES) return fail("الفيديو كبير جداً — الحد 230MB");
    } else if (f.size > MAX_DOC_BYTES) {
      return fail("الملف أكبر من 10MB — غير مسموح");
    }
    if (isVideo(f) && purpose === "player_video") {
      // Strict validation: 1-10 min, 360p min, no sign of editing.
      validatePlayerVideo(path.join(UPLOAD_DIR, f.filename), async (vr) => {
        if (!vr.ok) return failValidation(vr);
        records.push(await finalizeFileRecord(f, req.user.id));
        await nextFile(i + 1);
      });
    } else if (!isVideo(f) && purpose === "payment_receipt") {
      // Strict payment-receipt forensics: any sign of editing/tampering and
      // the image is rejected immediately (file deleted, never stored).
      validateReceipt(path.join(UPLOAD_DIR, f.filename), (vr) => {
        if (!vr.ok) return fail(vr.message);
        records.push(makeRecord(f, req.user.id));
        nextFile(i + 1);
      });
    } else {
      const record = await finalizeFileRecord(f, req.user.id);
      records.push(record);
      await nextFile(i + 1);
    }
  };
  await nextFile(0);
});

// POST /api/upload/register-upload — NO auth required. Used by the sign-up
// flow to upload proof documents / photo / videos BEFORE the account exists.
// Hardened against disk-fill: per-IP hourly byte quota + global pending cap
// (see ../uploadQuota), plus the same whitelist/size limits as /api/upload.
router.post("/register-upload", registerQuota, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided (use field name 'file')" });
  }
  chargeUpload(req, req.file.size); // account actual bytes received
  const purpose = String((req.body && req.body.purpose) || "");
  const full = path.join(UPLOAD_DIR, req.file.filename);
  const cleanup = () => cleanupFiles([req.file]);
  // Saturated ffmpeg pool -> 503 (retryable), not 400 "invalid video".
  const failValidation = (vr) => {
    cleanup();
    if (vr && vr.code === "busy") {
      return res.status(503).json({ error: vr.message, code: vr.code });
    }
    return res.status(400).json({ error: vr.message, code: vr.code });
  };
  const fail = (message) => {
    cleanup();
    return res.status(400).json({ error: message });
  };

  if (isVideo(req.file)) {
    if (req.file.size > MAX_VIDEO_BYTES) return fail("الفيديو كبير جداً — الحد 230MB");
  } else if (req.file.size > MAX_DOC_BYTES) {
    return fail("الملف أكبر من 10MB — غير مسموح");
  }

  const respond = async () => {
    const record = finalizeFileRecord(req.file, "pending");
    db.get().uploads.push(record);
    db.save();
    // NOTE: videos are NOT queued for thumb/compress here — finalizeFileRecord
    // owns that decision: ≤10MB videos get local thumb/compress only if the
    // cloud push fails, larger videos get it immediately.
    if (!isVideo(req.file) && req.file.mimetype && req.file.mimetype.startsWith("image/") && purpose !== "payment_receipt") {
      enqueueImageCompress(full, req.file.mimetype);
    }
    return res.status(201).json({ file: record });
  };

  if (isVideo(req.file) && purpose === "player_video") {
    // Strict validation: 1-10 min, 360p min, no sign of editing.
    validatePlayerVideo(full, async (vr) => {
      if (!vr.ok) return failValidation(vr);
      await respond();
    });
  } else {
    await respond();
  }
});

module.exports = router;

// Exported for tests: rewrite every reference to a local /uploads/ URL with a
// new (e.g. Cloudinary CDN) URL so promoted videos never leave dead links.
module.exports.rewriteReferencesToCloud = rewriteReferencesToCloud;