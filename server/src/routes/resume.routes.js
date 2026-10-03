// Resumable CHUNKED upload, used by the sign-up flow for large player videos.
// Unlike register-upload (single multipart POST, multer deletes the partial
// file if the body never fully arrives), this endpoint stores every 8MB chunk
// that reaches the server in a staging dir under server/.chunks/<uploadId>/ —
// OUTSIDE /uploads (which is statically served) so partials can never be
// fetched as files. When the network drops (mobile ISP/CGNAT silent stalls —
// the "52% forever" failure), the client asks /status, learns exactly which
// contiguous bytes the server already has, and resumes from there instead of
// restarting the 200MB video.
//
//   POST /api/upload/resume/start        {name,mime,purpose,size} -> {uploadId}
//   POST /api/upload/resume/chunk/:id    octet-stream body + Content-Range
//                                        bytes S-E/T -> {received}
//   GET  /api/upload/resume/status/:id   -> {received,total}
//   POST /api/upload/resume/complete     {uploadId} -> 201 {file: record}
//
// "complete" reuses the exact register-upload finalization (size caps, video
// validation, finalizeFileRecord, db record, background thumb/compress), so
// the response shape is identical to the old single-shot path.
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const { checkDeclaredQuota, CHUNK_DIR } = require("../uploadQuota");
const { enqueueImageCompress } = require("../imageCompress");
const { validatePlayerVideo } = require("../videoValidate");
const {
  UPLOAD_DIR,
  ALLOWED_MIME,
  MAX_DOC_BYTES,
  MAX_VIDEO_BYTES,
  isVideo,
  finalizeFileRecord
} = require("./uploads.routes");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

// Chunks arrive as raw application/octet-stream bodies (up to 8MB + slack),
// tagged with a Content-Range header. We deliberately do NOT use multer here:
// a chunk that stalls mid-body would leave a temp file multer then deletes on
// error anyway, and we need the start offset from the header to write the
// chunk to its exact byte position regardless of network flakiness.
const rawChunk = express.raw({ type: "application/octet-stream", limit: "12mb" });

function sessionDir(id) {
  return path.join(CHUNK_DIR, id);
}

function metaPath(id) {
  return path.join(sessionDir(id), "meta.json");
}

function safeBase(name) {
  const safe = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  return safe.replace(/\.[^.]*$/, "");
}

// How many CONTIGUOUS bytes (starting at 0) exist for the session. Compare to
// the chunk files on disk, sorted by start offset.
function contiguousReceived(id) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) return 0;
  let next = 0;
  const names = fs.readdirSync(dir);
  const starts = names
    .filter((n) => /^\d+$/.test(n))
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);
  for (const start of starts) {
    if (start > next) break; // gap before this chunk -> not contiguous
    const size = fs.statSync(path.join(dir, String(start))).size;
    next = Math.max(next, start + size);
  }
  return next;
}

// Parse "bytes start-end/total" -> {start,end,total} or null.
function parseContentRange(h) {
  if (!h) return null;
  const m = String(h).match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  const total = parseInt(m[3], 10);
  if (!(start >= 0 && end >= start && total >= 1)) return null;
  return { start, end, total };
}

// POST /start — reserve quota against the DECLARED total and create the
// session. Nothing is written to disk beyond a tiny meta.json here.
router.post("/start", (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  const mime = String((req.body && req.body.mime) || "").trim();
  const purpose = String((req.body && req.body.purpose) || "").trim();
  const size = Number(req.body && req.body.size) || 0;

  if (!name) return res.status(400).json({ error: "اسم الملف مطلوب" });
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    return res.status(400).json({ error: "File type not allowed: " + mime });
  }
  if (!(size > 0)) return res.status(400).json({ error: "حجم الملف غير صالح" });
  if (mime.startsWith("video/")) {
    if (size > MAX_VIDEO_BYTES) return res.status(400).json({ error: "الفيديو كبير جداً — الحد 400MB" });
  } else if (size > MAX_DOC_BYTES) {
    return res.status(400).json({ error: "الملف أكبر من 10MB — غير مسموح" });
  }

  const q = checkDeclaredQuota(req, size);
  if (!q.ok) return res.status(q.status).json({ error: q.error });
  req._resumeQuota = q.rec;

  const id = crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(sessionDir(id), { recursive: true });
  fs.writeFileSync(
    metaPath(id),
    JSON.stringify({ id, name, mime, purpose, size, ext, createdAt: new Date().toISOString() })
  );
  return res.json({ uploadId: id, size });
});

// POST /chunk/:id — one 8MB slice. Writes it to .chunks/<id>/<start> and
// reports the contiguous byte count so the client can resume from the (first)
// gap without re-sending acknowledged bytes.
router.post("/chunk/:id", rawChunk, (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{24}$/.test(id)) {
    return res.status(404).json({ error: "جلسة الرفع غير موجودة" });
  }
  const mp = metaPath(id);
  if (!fs.existsSync(mp)) {
    return res.status(404).json({ error: "جلسة الرفع غير موجودة — ابدأ رفعاً جديداً" });
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(mp, "utf8")); } catch (e) {
    return res.status(404).json({ error: "جلسة الرفع غير صالحة" });
  }
  const cr = parseContentRange(req.headers["content-range"]);
  if (!cr) {
    return res.status(400).json({ error: "ترويسة Content-Range مفقودة أو غير صحيحة" });
  }
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({ error: "لا يوجد محتوى في هذه الحزمة" });
  }
  const expectedLen = cr.end - cr.start + 1;
  if (body.length !== expectedLen) {
    return res.status(400).json({ error: "حجم الحزمة لا يطابق Content-Range" });
  }
  if (cr.total !== meta.size) {
    return res.status(400).json({ error: "الحجم الكلي لا يطابق بداية الرفع" });
  }
  if (cr.end >= meta.size) {
    return res.status(400).json({ error: "نطاق خارج حدود الملف" });
  }
  // Overwrite instead of append: a retried chunk (client got a stale offset
  // from /status after the network blipped) must produce a consistent file.
  fs.writeFileSync(path.join(sessionDir(id), String(cr.start)), body);
  return res.json({ uploadId: id, received: contiguousReceived(id), total: meta.size });
});

// GET /status/:id — where can the upload continue from?
router.get("/status/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{24}$/.test(id)) return res.status(404).json({ error: "not found" });
  const mp = metaPath(id);
  if (!fs.existsSync(mp)) return res.status(404).json({ error: "not found" });
  let meta;
  try { meta = JSON.parse(fs.readFileSync(mp, "utf8")); } catch (e) {
    return res.status(404).json({ error: "not found" });
  }
  return res.json({ uploadId: id, received: contiguousReceived(id), total: meta.size });
});

// POST /complete — assemble all chunks into the final file (multer-style
// random filename in UPLOAD_DIR), then run the EXACT register-upload
// finalization so the {file} response is identical.
router.post("/complete", async (req, res) => {
  const id = String((req.body && req.body.uploadId) || "");
  if (!/^[a-f0-9]{24}$/.test(id)) {
    return res.status(400).json({ error: "معرّف الرفع مفقود" });
  }
  const mp = metaPath(id);
  const dir = sessionDir(id);
  if (!fs.existsSync(mp)) {
    return res.status(404).json({ error: "جلسة الرفع غير موجودة — ابدأ رفعاً جديداً" });
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(mp, "utf8")); } catch (e) {
    return res.status(404).json({ error: "جلسة الرفع غير صالحة" });
  }

  const received = contiguousReceived(id);
  if (received < meta.size) {
    // Not all bytes on disk yet -> tell the client exactly where to resume.
    return res.status(409).json({ uploadId: id, received, total: meta.size, error: "الرفع غير مكتمل بعد" });
  }

  // Assemble to a temp file in UPLOAD_DIR, then rename to the final name so a
  // crash mid-assembly never leaves a half-built file under a real /uploads/ URL.
  const tmp = path.join(UPLOAD_DIR, ".assemble-" + crypto.randomBytes(6).toString("hex"));
  try {
    const names = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const fd = fs.openSync(tmp, "w");
    for (const n of names) {
      const data = fs.readFileSync(path.join(dir, n));
      fs.writeSync(fd, data);
    }
    fs.closeSync(fd);
    if (fs.statSync(tmp).size !== meta.size) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      return res.status(400).json({ error: "تعذر تجميع الملف — حجم غير مطابق" });
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    console.error("[resume] assemble failed:", e && e.message);
    return res.status(503).json({ error: "تعذر تجميع الملف — حاول مرة أخرى" });
  }

  const filename = Date.now() + "_" + db.nextId("upload") + "_" + crypto.randomBytes(4).toString("hex") + "_" + safeBase(meta.name) + meta.ext;
  const full = path.join(UPLOAD_DIR, filename);
  fs.renameSync(tmp, full);

  // Cleanup like register-upload's `fail`/`failValidation` (deletes the final
  // file + any companion thumb) AND the staged chunk session.
  const discardSession = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  };
  const cleanup = () => {
    const fileLike = { filename, originalname: meta.name, mimetype: meta.mime, size: meta.size };
    const { cleanupFiles } = require("./uploads.routes");
    cleanupFiles([fileLike]);
    discardSession();
  };
  const fail = (message) => {
    cleanup();
    return res.status(400).json({ error: message });
  };
  const failValidation = (vr) => {
    cleanup();
    if (vr && vr.code === "busy") {
      return res.status(503).json({ error: vr.message, code: vr.code });
    }
    return res.status(400).json({ error: vr.message, code: vr.code });
  };
  const fileLike = { filename, originalname: meta.name, mimetype: meta.mime, size: meta.size };

  if (isVideo(fileLike)) {
    if (fileLike.size > MAX_VIDEO_BYTES) return fail("الفيديو كبير جداً — الحد 400MB");
  } else if (fileLike.size > MAX_DOC_BYTES) {
    return fail("الملف أكبر من 10MB — غير مسموح");
  }

  const respond = async () => {
    const record = finalizeFileRecord(fileLike, "pending");
    db.get().uploads.push(record);
    db.save();
    if (!isVideo(fileLike) && fileLike.mimetype && fileLike.mimetype.startsWith("image/") && meta.purpose !== "payment_receipt") {
      enqueueImageCompress(full, fileLike.mimetype);
    }
    discardSession();
    return res.status(201).json({ file: record });
  };

  if (isVideo(fileLike) && meta.purpose === "player_video") {
    validatePlayerVideo(full, async (vr) => {
      if (!vr.ok) return failValidation(vr);
      await respond();
    });
  } else {
    await respond();
  }
});

module.exports = router;