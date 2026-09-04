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
  // 100MB cap per file — matches the Cloudinary free-plan hard limit (videos
  // are pushed to Cloudinary right after upload, anything bigger would fail
  // there with a confusing error). At phone bitrates this is ~10 minutes.
  limits: { fileSize: 100 * 1024 * 1024 },
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
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // videos: 100MB (Cloudinary free limit)
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

function cleanupFiles(list) {
  (list || []).forEach((f) => {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, f.filename));
    } catch (e) {}
  });
}

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// Videos must live on Cloudinary (CDN delivery, offsite storage, works on
// mobile data). The local disk file is only a staging area — BUT the HTTP
// response does NOT wait for the cloud hop: uploading the same file again
// from the server used to block the player's request for minutes on slow
// connections. Instead the record is stored/returned immediately with the
// local URL and promoted to Cloudinary in the BACKGROUND; once the push
// succeeds the record is switched to the CDN URL and the local copy removed.
// If Cloudinary fails we simply keep serving the local file (same fallback
// as before) and queue thumbnail/compression for it.
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
      }
      // Keep every consumer (player.videos, registration.videos, ...) pointed
      // at a live URL now that the local file is about to be removed.
      rewriteReferencesToCloud(db.get(), oldUrl, res.secure_url);
      db.save();
      try { fs.unlinkSync(localPath); } catch (e) {}
      console.log("☁️ video promoted to Cloudinary:", res.secure_url);
    } catch (e) {
      console.warn("⚠️ Cloudinary (background) error:", e && e.message);
      enqueueThumb(localPath);
      enqueueCompress(localPath);
    }
  });
}

// Builds the stored record for an uploaded file. Videos are scheduled for
// Cloudinary promotion in the background (never blocking the response);
// every other file type stays on local disk as before.
function finalizeFileRecord(f, uploadedBy) {
  const record = makeRecord(f, uploadedBy);
  if (!isVideo(f)) return record;
  const localPath = path.join(UPLOAD_DIR, f.filename);
  if (!cloudinaryConfigured()) {
    enqueueThumb(localPath);
    enqueueCompress(localPath);
    return record;
  }
  promoteToCloudLater(record, localPath);
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
  const fail = (message) => {
    cleanupFiles(req.files);
    return res.status(400).json({ error: message });
  };

  const nextFile = async (i) => {
    if (i >= req.files.length) {
      db.get().uploads.push(...records);
      db.save();
      // Background processing only applies to files that stay on local disk.
      // Videos are handled by the background Cloudinary promotion itself, so
      // they are skipped here (no thumb/compress for a file that may vanish).
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
      if (f.size > MAX_VIDEO_BYTES) return fail("الفيديو كبير جداً — الحد 100MB (حوالي 10 دقائق بجودة الهاتف)");
    } else if (f.size > MAX_DOC_BYTES) {
      return fail("الملف أكبر من 10MB — غير مسموح");
    }
    if (isVideo(f) && purpose === "player_video") {
      // Strict validation: 5-15 min + no sign of editing.
      validatePlayerVideo(path.join(UPLOAD_DIR, f.filename), async (vr) => {
        if (!vr.ok) return fail(vr.message);
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
  const fail = (message) => {
    cleanup();
    return res.status(400).json({ error: message });
  };

  if (isVideo(req.file)) {
    if (req.file.size > MAX_VIDEO_BYTES) return fail("الفيديو كبير جداً — الحد 100MB (حوالي 10 دقائق بجودة الهاتف)");
  } else if (req.file.size > MAX_DOC_BYTES) {
    return fail("الملف أكبر من 10MB — غير مسموح");
  }

  const respond = async () => {
    const record = finalizeFileRecord(req.file, "pending");
    db.get().uploads.push(record);
    db.save();
    // NOTE: videos are NOT queued for thumb/compress here — the background
    // Cloudinary promotion owns that decision (it queues them only if the
    // cloud push fails and the file stays local).
    if (!isVideo(req.file) && req.file.mimetype && req.file.mimetype.startsWith("image/") && purpose !== "payment_receipt") {
      enqueueImageCompress(full, req.file.mimetype);
    }
    return res.status(201).json({ file: record });
  };

  if (isVideo(req.file) && purpose === "player_video") {
    // Strict validation: 5-15 min + no sign of editing.
    validatePlayerVideo(full, async (vr) => {
      if (!vr.ok) return fail(vr.message);
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