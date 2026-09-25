// Direct-to-Cloudinary upload (no double hop): the sign-up flow sends a playe
// highlight video STRAIGHT to Cloudinary instead of uploading it to this serve
// (which then re-uploaded it to the CDN). The server never touches the big
// bytes — it only:
//   /sign    issues a short-lived signed upload permit (public_id + signature)
//   /confirm pulls the CDN copy back, runs the same strict validation as
//            register-upload (duration + anti-montage), then stores a normal
//            upload record pointing at the CDN URL; rejects destroy the media.
// The per-IP byte quota from registration uploads gates both endpoints, and
// outstanding permits are bounded so the free-plan Cloudinary storage cannot
// be filled by abusing /sign.
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const cloudinary = require("cloudinary").v2;
const db = require("../db");
const { validatePlayerVideo } = require("../videoValidate");
const { registerQuota, chargeUpload } = require("../uploadQuota");
const mg = require("../mediaGuard");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
const MAX_VIDEO_BYTES = 230 * 1024 * 1024; // 230MB (Cloudinary free-plan hard cap is 100MB — bigger will fail at Cloudinary)
const PERMIT_TTL_MS = 40 * 60 * 1000; // a phone on mobile data may take a while
const MAX_PERMIT_BY_IP = 10; // cap outstanding (signed-not-confirmed) permits
const DIRECT_FOLDER = "manara/videos"; // separate from background promotion
const CLOUD_MAX_AGE_MS = 26 * 60 * 60 * 1000; // orphan cloud sweeps (26h cushion)

// One-time upload permits: public_id -> { ip, issuedAt }. Not persisted —
// a server restart invalidates outstanding permits, and the client falls back
// to the legacy local upload exactly as it does on any confirm failure.
const permits = new Map();

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// Cloudinary v1 signed-upload signature: SHA1 over the alphabetically sorted
// "k=v" parameter list (file / api_key / cloud_name excluded) + API secret.
function signParams(params) {
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();
  const canonical = sorted.map((k) => k + "=" + params[k]).join("&");
  return crypto
    .createHash("sha1")
    .update(canonical + process.env.CLOUDINARY_API_SECRET)
    .digest("hex");
}

function pruneExpiredPermits() {
  const cutoff = Date.now() - PERMIT_TTL_MS;
  permits.forEach((entry, publicId) => {
    if (entry.issuedAt < cutoff) permits.delete(publicId);
  });
}

function download(url, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    let written = 0;
    let aborted = false;
    const fail = (e) => {
      if (aborted) return;
      aborted = true;
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(e);
    };
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("download failed: " + res.statusCode));
      }
      // HARD CAP: the declared body length is checked BEFORE a single byte is
      // written, and the streamed total is checked continuously. The previous
      // `res.pipe(out)` had neither, so a permit-holder could stream an
      // arbitrarily large body into /uploads and blow past every quota.
      const declared = parseInt(res.headers["content-length"] || "0", 10) || 0;
      if (declared > maxBytes) {
        res.resume();
        return fail(new Error("declared body too large: " + declared + " > " + maxBytes));
      }
      const out = fs.createWriteStream(dest);
      out.on("finish", () => out.close(() => resolve(written)));
      out.on("error", (e) => fail(e));
      res.on("data", (c) => {
        if (aborted) return;
        written += c.length;
        if (written > maxBytes) {
          res.destroy();
          out.destroy();
          fail(new Error("streamed body too large: > " + maxBytes));
        }
      });
      res.pipe(out);
    });
    req.on("error", (e) => fail(e));
    req.setTimeout(300000, () => req.destroy(new Error("download timeout")));
  });
}

// Total bytes being pulled from the CDN at this instant. A flood of parallel
// /confirm calls each writes up to MAX_VIDEO_BYTES to the local disk BEFORE any
// record exists, so uploadQuota's global pending cap (which only sums db.uploads
// records) could not see them. This budget makes those writes visible.
let inflightBytes = 0;
const MAX_INFLIGHT_BYTES = 512 * 1024 * 1024;

// Best-effort delete of a rejected CDN asset. Every failure path after the
// permit is consumed must call this, otherwise an attacker can fill the
// free-plan Cloudinary quota with assets that will never be confirmed — the
// 26h orphan sweep is far too slow to be the only line of defence.
async function destroyCdnCopy(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
  } catch (e) {
    /* nothing else we can do; the sweep will catch it */
  }
}

// POST /api/upload/direct/sign — NO auth. Returns the params the browser POSTs
// straight to Cloudinary (multipart) so the video lands in OUR account.
router.post("/sign", registerQuota, (req, res) => {
  const purpose = String((req.body && req.body.purpose) || "");
  if (purpose !== "player_video") {
    return res.status(400).json({ error: "الغرض غير مدعوم للرفع المباشر" });
  }
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ error: "الخدمة غير جاهزة حالياً — أعد المحاولة لاحقاً" });
  }
  pruneExpiredPermits();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  let ipCount = 0;
  permits.forEach((entry) => { if (entry.ip === ip) ipCount++; });
  if (ipCount >= MAX_PERMIT_BY_IP) {
    return res.status(429).json({ error: "في انتظار تأكيد الرفعات السابقة — أعد المحاولة بعد قليل" });
  }

  const publicId = DIRECT_FOLDER + "/reg_" + crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { public_id: publicId, timestamp };
  permits.set(publicId, { ip, issuedAt: Date.now() });
  return res.json({
    endpoint:
      "https://api.cloudinary.com/v1_1/" +
      process.env.CLOUDINARY_CLOUD_NAME +
      "/video/upload",
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    public_id: publicId,
    timestamp: timestamp,
    signature: signParams(params)
  });
});

// POST /api/upload/direct/confirm — NO auth. JSON body: purpose, public_id,
// secure_url, bytes, width, height, duration, format, originalname.
// Validates the CDN copy (duration + scene cuts like register-upload), then
// records it. On rejection the cloud media is destroyed (best effort) and 400
// is returned with the same Arabic explanation the player already knows.
router.post("/confirm", registerQuota, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const purpose = String(body.purpose || "");
  const publicId = String(body.public_id || "");
  const secureUrl = String(body.secure_url || "");
  const bytes = parseInt(body.bytes, 10) || 0;

  if (purpose !== "player_video") {
    return res.status(400).json({ error: "الغرض غير مدعوم للرفع المباشر" });
  }
  if (!permits.has(publicId)) {
    return res.status(400).json({ error: "طلب الرفع المباشر منتهي أو غير صالح — أعد الرفع من جديد" });
  }
  permits.delete(publicId); // one-time use
  if (bytes <= 0 || bytes > MAX_VIDEO_BYTES) {
    return res.status(400).json({ error: "الفيديو كبير جداً — الحد 230MB" });
  }
  if (db.get().uploads.some((u) => u.publicId === publicId)) {
    return res.status(409).json({ error: "هذا الفيديو مُسجَّل مسبقاً" });
  }

  // STRICT url <-> permit binding (was: startsWith(host) && includes(publicId)).
  // `includes` is a substring test, so "<host>/video/upload/<publicId>/../../x"
  // or a public_id merely CONTAINING the permit id both passed. Parse the URL and
  // require an exact public_id match inside our own DIRECT_FOLDER.
  const parsed = mg.parseCloudinaryUrl(secureUrl);
  if (
    !parsed ||
    parsed.cloud !== String(process.env.CLOUDINARY_CLOUD_NAME || "").toLowerCase() ||
    parsed.resourceType !== "video" ||
    parsed.publicId !== publicId ||
    parsed.folder !== DIRECT_FOLDER + "/"
  ) {
    return res.status(400).json({ error: "رابط الفيديو لا يطابق طلب الرفع المباشر" });
  }

  chargeUpload(req, bytes); // count the real bytes against the per-IP quota

  // The CDN copy is pulled to local disk before any record exists, so the
  // global pending cap cannot see it. Charge it against an in-flight budget and
  // fail fast rather than letting N parallel /confirm calls fill the disk.
  const wantBytes = Math.min(bytes, MAX_VIDEO_BYTES);
  if (inflightBytes + wantBytes > MAX_INFLIGHT_BYTES) {
    return res.status(503).json({ error: "الخدمة مشغولة حالياً — أعد المحاولة بعد قليل" });
  }
  inflightBytes += wantBytes;

  const tmp = path.join(
    UPLOAD_DIR,
    "tmp_direct_" + crypto.randomBytes(6).toString("hex") + ".mp4"
  );
  try {
    await download(secureUrl, tmp, wantBytes);
  } catch (e) {
    inflightBytes = Math.max(0, inflightBytes - wantBytes);
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (/too large/.test(String(e && e.message))) {
      // The permit is already consumed, so a retry cannot fix an oversized
      // asset — delete the CDN copy now instead of leaving it to sit in the
      // free-plan quota until the 26h orphan sweep.
      await destroyCdnCopy(publicId);
      return res.status(413).json({ error: "حجم الفيديو من السحابة أكبر من المسموح" });
    }
    return res.status(502).json({ error: "تعذر سحب الفيديو من السحابة — أعد المحاولة" });
  }
  inflightBytes = Math.max(0, inflightBytes - wantBytes);

  // The CDN body is the real thing: trust the file, not the client's `bytes`.
  let actual = 0;
  try { actual = fs.statSync(tmp).size; } catch (e) {}
  if (actual <= 0 || actual > MAX_VIDEO_BYTES) {
    try { fs.unlinkSync(tmp); } catch (e) {}
    await destroyCdnCopy(publicId);
    return res.status(413).json({ error: "حجم الفيديو من السحابة غير صالح" });
  }

  validatePlayerVideo(tmp, async (vr) => {
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (!vr.ok) {
      // The ffmpeg pool is saturated — do NOT blame the player's video, and do
      // not destroy the CDN copy: tell them to retry the confirm.
      if (vr.code === "busy") {
        return res.status(503).json({ error: vr.message, code: vr.code });
      }
      // Destroy the rejected CDN copy BEFORE answering, so the media can never
      // linger if the client goes away right after reading the 400.
      await destroyCdnCopy(publicId);
      return res.status(400).json({ error: vr.message, code: vr.code });
    }
    const record = {
      id: "up_" + db.nextId("upload"),
      url: secureUrl,
      name: String(body.originalname || "video.mp4").slice(0, 200),
      size: actual,
      mimetype: "video/mp4",
      uploadedBy: "pending",
      publicId: publicId,
      provider: "cloudinary",
      createdAt: new Date().toISOString()
    };
    db.get().uploads.push(record);
    db.save();
    return res.status(201).json({ file: record });
  });
});

// Orphan-cloud sweep: registration videos uploaded straight to Cloudinary whose
// permit expired (browser died between upload and confirm) would otherwise sit
// in the free account forever. Every 6h delete DIRECT_FOLDER media that is
// older than 26h and not referenced by any stored upload record.
function sweepOrphanCloudVideos() {
  const mine = new Set(
    (db.get().uploads || []).map((u) => u.publicId).filter(Boolean)
  );
  const cutoff = Date.now() - CLOUD_MAX_AGE_MS;
  const fetchPage = (cursor) =>
    new Promise((resolve, reject) => {
      cloudinary.api.resources(
        {
          type: "upload",
          resource_type: "video",
          prefix: DIRECT_FOLDER + "/",
          max_results: 200,
          next_cursor: cursor || undefined
        },
        (err, result) => (err ? reject(err) : resolve(result || {}))
      );
    });

  (async () => {
    try {
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const result = await fetchPage(cursor);
        const stale = (result.resources || []).filter((r) => {
          const age = new Date(r.created_at || r.updated_at || 0).getTime();
          return r.public_id && !mine.has(r.public_id) && age < cutoff;
        });
        for (const r of stale) {
          try { await cloudinary.uploader.destroy(r.public_id, { resource_type: "video" }); } catch (e) {}
        }
        if (stale.length) console.log("[direct-upload] swept " + stale.length + " orphan cloud video(s)");
        if (!result.next_cursor) break;
        cursor = result.next_cursor;
      }
    } catch (e) {
      // Cloudinary unhealthy — try again next run.
    }
  })();
}
setInterval(sweepOrphanCloudVideos, 6 * 60 * 60 * 1000).unref();

module.exports = router;