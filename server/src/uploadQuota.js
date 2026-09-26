// Hardening for the UNAUTHENTICATED register-upload endpoint (sign-up flow).
// Without this, any IP could fill the disk: 60 requests/hour (app-level cap)
// x 1GB per file = 60GB/hour. Defense in depth:
//   1) Per-IP HOURLY BYTE QUOTA (reject by Content-Length before multer
//      writes anything; actual bytes are charged after the upload).
//   2) GLOBAL cap on bytes held by pre-registration ("pending") uploads.
//   3) Orphan sweep: pending uploads older than 24h that are no longer
//      referenced by any document (user/player/club/registration/...) are
//      deleted — files only referenced after a completed sign-up survive.
const fs = require("fs");
const path = require("path");
const db = require("./db");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
// Staging dir for the RESUMABLE chunked upload (resume.routes.js). Kept OUTSIDE
// /uploads because that folder is statically served: a private .chunks dir can
// never be enumerated/fetched as files, and partial uploads must stay hidden.
const CHUNK_DIR = path.join(__dirname, "..", ".chunks");

const QUOTA_WINDOW_MS = 60 * 60 * 1000;
const IP_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2GB / hour / IP
const GLOBAL_PENDING_MAX_BYTES = 4 * 1024 * 1024 * 1024; // hard cap on pending uploads
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // orphan files older than 24h

const ipQuota = new Map(); // ip -> { start, bytes }

function pendingTotalBytes(store) {
  if (!store) return 0;
  return (store.uploads || [])
    .filter((u) => u.uploadedBy === "pending")
    .reduce((s, u) => s + (Number(u.size) || 0), 0);
}

function registerQuota(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  // Prune stale IP entries when the map grows (memory bound for long uptime).
  if (ipQuota.size > 10000) {
    ipQuota.forEach((rec, key) => { if (now - rec.start >= QUOTA_WINDOW_MS) ipQuota.delete(key); });
  }
  let rec = ipQuota.get(ip);
  if (!rec || now - rec.start >= QUOTA_WINDOW_MS) {
    rec = { start: now, bytes: 0 };
    ipQuota.set(ip, rec);
  }
  const declared = parseInt(req.headers["content-length"] || "0", 10) || 0;
  if (rec.bytes + declared > IP_QUOTA_BYTES) {
    return res.status(429).json({ error: "وصلت لحد الرفع المسموح لهذه الساعة — حاول لاحقاً" });
  }
  if (pendingTotalBytes(db.get()) + declared > GLOBAL_PENDING_MAX_BYTES) {
    return res.status(503).json({ error: "الخدمة مشغولة حالياً — حاول لاحقاً" });
  }
  req._uploadQuotaRec = rec;
  next();
}

// Charge the ACTUAL received bytes (Content-Length can be spoofed; f.size
// cannot). Must be called right after multer finished parsing the body.
function chargeUpload(req, bytes) {
  if (req._uploadQuotaRec) req._uploadQuotaRec.bytes += Number(bytes) || 0;
}

// Declared-size variant for the resumable chunked upload: the START request
// carries the TOTAL file size in its JSON body (not in Content-Length, which
// only holds the tiny JSON), so the per-IP/global quota must be checked and
// reserved against that declared total before any chunk is written to disk.
function checkDeclaredQuota(req, declaredBytes) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  if (ipQuota.size > 10000) {
    ipQuota.forEach((rec, key) => { if (now - rec.start >= QUOTA_WINDOW_MS) ipQuota.delete(key); });
  }
  let rec = ipQuota.get(ip);
  if (!rec || now - rec.start >= QUOTA_WINDOW_MS) {
    rec = { start: now, bytes: 0 };
    ipQuota.set(ip, rec);
  }
  if (rec.bytes + Number(declaredBytes) > IP_QUOTA_BYTES) {
    return { ok: false, status: 429, error: "وصلت لحد الرفع المسموح لهذه الساعة — حاول لاحقاً" };
  }
  if (pendingTotalBytes(db.get()) + Number(declaredBytes) > GLOBAL_PENDING_MAX_BYTES) {
    return { ok: false, status: 503, error: "الخدمة مشغولة حالياً — حاول لاحقاً" };
  }
  // Reserve the DECLARED total up-front (the client may be interrupted before
  // the last chunk, but the bytes are already accounted against this IP's
  // hourly cap — the same protection register-upload gets per-request).
  rec.bytes += Number(declaredBytes) || 0;
  return { ok: true, rec };
}

// Every /uploads/ URL still referenced by any document on the platform.
function collectReferencedUrls() {
  const store = db.get();
  const urls = new Set();
  const scan = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      // Local files live under /uploads/; remote (Cloudinary) URLs are https.
      // Both must be treated as "referenced" so the orphan sweep never deletes
      // a record that a profile/document still points at — otherwise a promoted
      // video (whose URL is now a CDN link) is wrongly seen as orphaned.
      if (v.startsWith("/uploads/") || /^https?:\/\//i.test(v)) urls.add(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach(scan); return; }
    if (typeof v === "object") { Object.keys(v).forEach((k) => scan(v[k])); }
  };
  ["users", "players", "clubs", "registrations", "transactions", "ai_chats", "messages", "applications"]
    .forEach((col) => (store[col] || []).forEach(scan));
  return urls;
}

// When a registration completes, the files it references (videos / documents /
// photo) are still recorded as `uploadedBy: "pending"`. That is correct BEFORE
// the account exists, but once the player/club profile references them we must
// "claim" ownership so the orphan sweep can never delete a registered user's
// media. Without this, a video uploaded during sign-up and committed to the
// profile could be swept ~24h later (if the sweep ran before the profile
// referenced it, or on any future reference-timing edge case) — leaving the
// profile pointing at a dead /uploads/ URL ("videos vanish after a day").
function claimUploads(store, urls, userId) {
  if (!store || !Array.isArray(urls) || !userId) return;
  const wanted = new Set(
    urls.filter((u) => typeof u === "string" && u.startsWith("/uploads/"))
  );
  if (!wanted.size) return;
  (store.uploads || []).forEach((u) => {
    if (wanted.has(u.url) && u.uploadedBy === "pending") u.uploadedBy = userId;
  });
}

function sweepOrphanPendingUploads() {
  try {
    const store = db.get();
    const referenced = collectReferencedUrls();
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    const keep = [];
    let removed = 0;
    (store.uploads || []).forEach((u) => {
      const oldPending = u.uploadedBy === "pending" &&
        u.createdAt && new Date(u.createdAt).getTime() < cutoff;
      if (oldPending && !referenced.has(u.url)) {
        const full = path.join(UPLOAD_DIR, path.basename(u.url));
        try { fs.unlinkSync(full); } catch (e) {}
        // Remove the companion auto-generated poster (<video>.jpg) too, or an
        // orphaned thumbnail is left behind whenever an old video is swept.
        try { fs.unlinkSync(full.replace(/\.[^/.]+$/, "") + ".jpg"); } catch (e) {}
        removed++;
      } else {
        keep.push(u);
      }
    });
    if (removed) {
      store.uploads = keep;
      db.save();
    }
    console.log("[uploads] swept " + removed + " orphan pending upload(s)");
  } catch (e) {}
}

// Delete staged chunk sessions (.chunks/<id>/) that are older than the
// pending-upload cutoff. An upload that dies mid-way (network drop, tab close)
// would otherwise leave 8MB chunks on disk forever. Runs on the same hourly
// sweep as sweepOrphanPendingUploads.
function sweepStaleChunkSessions() {
  try {
    if (!fs.existsSync(CHUNK_DIR)) return;
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    let removed = 0;
    fs.readdirSync(CHUNK_DIR).forEach((id) => {
      const dir = path.join(CHUNK_DIR, id);
      let st;
      try { st = fs.statSync(dir); } catch (e) { return; }
      if (!st.isDirectory() || st.mtimeMs >= cutoff) return;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch (e) {}
    });
    if (removed) console.log("[resume] swept " + removed + " stale chunk session(s)");
  } catch (e) {}
}

module.exports = {
  registerQuota,
  chargeUpload,
  checkDeclaredQuota,
  sweepOrphanPendingUploads,
  sweepStaleChunkSessions,
  collectReferencedUrls,
  claimUploads,
  QUOTA_WINDOW_MS,
  IP_QUOTA_BYTES,
  GLOBAL_PENDING_MAX_BYTES,
  PENDING_MAX_AGE_MS,
  CHUNK_DIR
};