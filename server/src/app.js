const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const rateLimit = require("./middleware/rateLimit");
const { SECRET, tokenFromRequest, csrfProtect } = require("./middleware/auth");

const app = express();

// --- Reverse proxy support (nginx on the VPS) ---
// Without this, req.ip is the proxy's address and ALL users share one rate
// limit bucket. Set TRUST_PROXY=1 when running behind nginx/LB.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", process.env.TRUST_PROXY === "loopback" ? "loopback" : Number(process.env.TRUST_PROXY) || 1);
}

// --- Security headers ---
// Partial Content-Security-Policy: enabled without breaking the existing
// design. The pages rely on many inline <script> / style attributes (no nonces
// in place yet), so script-src/style-src keep 'unsafe-inline' — but anything
// genuinely dangerous is blocked: no third-party object/plugin loading, no
// <base> tag redirection, no cross-origin form submission, no clickjacking,
// and NO externally-hosted scripts (script-src is 'self' only). This shrinks
// the XSS surface while keeping every existing page working.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "img-src": ["'self'", "data:", "blob:", "https://images.unsplash.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "connect-src": ["'self'", "https://fonts.googleapis.com"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// --- Request logging ---
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// --- CORS (restrict in production) ---
const corsOrigin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*"
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : "*";
app.use(cors({ origin: corsOrigin, credentials: corsOrigin !== "*" }));

// --- NoSQL injection prevention + HTTP parameter pollution ---
app.use(mongoSanitize());
app.use(hpp());

// --- Payment-provider webhooks need the RAW body for signature verification ---
app.use("/api/subscription/webhook", express.raw({ type: () => true }), require("./routes/webhook.routes"));

// --- Body parsing with explicit limits ---
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// --- CSRF: double-submit cookie on cookie-authenticated state changes ---
// (Authorization-header-only requests and the raw webhook keep working
// unchanged; see middleware/auth.js for the full reasoning.)
app.use("/api", csrfProtect);

// ---------------------------------------------------------------------------
// Protected media: /uploads is served publicly ONLY for photos / videos / logos.
// Proof documents (birth certificate, medical report, declaration, official
// letter, license) and payment receipts are private — only the owner of the
// account that uploaded them and the admin can view them.
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

function privateUploadUrls() {
  const store = db.get();
  const urls = new Set();
  const add = (v) => {
    if (v && typeof v === "string" && v.startsWith("/uploads/")) urls.add(v);
  };
  const addDocs = (rec) => {
    const d = (rec && rec.documents) || {};
    Object.keys(d).forEach((k) => add(d[k]));
    if (rec && rec.declaration) add(rec.declaration);
  };
  (store.registrations || []).forEach(addDocs);
  (store.players || []).forEach(addDocs);
  (store.clubs || []).forEach(addDocs);
  (store.transactions || []).forEach((t) => add(t.transactionScreenshot));
  return urls;
}

function documentOwner(url) {
  const store = db.get();
  const match = (v) => v && typeof v === "string" && v === url;
  const findOwner = (rec) => {
    const d = (rec && rec.documents) || {};
    if (Object.keys(d).some((k) => match(d[k])) || (rec && match(rec.declaration))) return rec.userId || null;
    return null;
  };
  for (const r of store.registrations || []) { const o = findOwner(r); if (o) return o; }
  for (const p of store.players || []) { const o = findOwner(p); if (o) return o; }
  for (const c of store.clubs || []) { const o = findOwner(c); if (o) return o; }
  for (const t of store.transactions || []) {
    if (match(t.transactionScreenshot)) return t.userId || null;
  }
  return null;
}

// TRUE only when `url` is a player's MEDICAL REPORT (documents.medical).
// Used to grant authenticated clubs read access to that single document
// without opening birth certificates / declarations / receipts.
function isMedicalDocument(url) {
  const store = db.get();
  for (const p of store.players || []) {
    const d = (p && p.documents) || {};
    if (d.medical && d.medical === url) return true;
  }
  return false;
}

function serveUpload(req, res) {
  const name = path.basename(decodeURIComponent(req.path || ""));
  if (!name) return res.status(404).end();
  const filePath = path.join(UPLOAD_DIR, name);
  const url = "/uploads/" + name;
  const done = (err) => {
    if (err && !res.headersSent) res.status(404).end();
  };

  if (!privateUploadUrls().has(url)) {
    return res.sendFile(filePath, done);
  }

  const token = tokenFromRequest(req);
  let user = null;
  if (token) {
    try { user = jwt.verify(token, SECRET); } catch (e) { /* ignore */ }
  }
  const ownerId = documentOwner(url);
  // Exception: an authenticated CLUB may view a player's medical report only
  // (product rule) — every other private document stays owner/admin-only.
  const clubMedical = user && user.role === "club" && isMedicalDocument(url);
  if (!user || (user.role !== "admin" && (ownerId == null || user.id !== ownerId) && !clubMedical)) {
    return res.status(403).json({ error: "Access denied" });
  }
  res.set("Cache-Control", "no-store");
  return res.sendFile(filePath, done);
}

app.use("/uploads", serveUpload);

// API
app.get("/api/health", (req, res) => res.json({ ok: true, name: "Manara API" }));

// Live platform stats — players count + clubs split by type
// (only profiles whose account passed admin review are counted)
app.get("/api/stats", (req, res) => {
  const store = db.get();
  const players = store.players.filter((p) => p.userId && db.profileApproved(p));
  const clubs = store.clubs.filter((c) => c.userId && db.profileApproved(c));
  function clubCat(t) {
    const s = String(t || "").toLowerCase();
    if (s.includes("محترف") || s.includes("professional")) return "نادي محترف";
    if (s.includes("أكاديم") || s.includes("academy")) return "أكاديمية";
    if (s.includes("هاو") || s.includes("amateur")) return "نادي هاوٍ";
    if (s.includes("تدريب") || s.includes("training") || s.includes("center")) return "مركز تدريب";
    if (s.includes("منتخب") || s.includes("national") || s.includes("federation") || s.includes("team")) return "منتخب";
    return "أخرى";
  }
  const byType = {};
  clubs.forEach((c) => { const k = clubCat(c.type); byType[k] = (byType[k] || 0) + 1; });
  const bySport = {};
  players.forEach((p) => {
    const k = String(p.sport || "أخرى");
    bySport[k] = (bySport[k] || 0) + 1;
  });
  const sportSet = new Set();
  players.forEach((p) => { if (p.sport && String(p.sport).trim()) sportSet.add(String(p.sport).trim()); });
  clubs.forEach((c) => { if (c.sport && String(c.sport).trim()) sportSet.add(String(c.sport).trim()); });
  const countrySet = new Set();
  players.forEach((p) => { if (p.country && String(p.country).trim()) countrySet.add(String(p.country).trim()); });
  clubs.forEach((c) => { if (c.country && String(c.country).trim()) countrySet.add(String(c.country).trim()); });
  res.json({
    players: players.length,
    clubs: clubs.length,
    byType,
    bySport,
    sports: sportSet.size,
    countries: countrySet.size
  });
});

// Rate limiting on sensitive endpoints (brute-force / DoS protection)
app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));
app.use("/api/auth/register", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
app.use("/api/auth/status", rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }));
app.use("/api/auth/send-verification", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use("/api/auth/verify-email", rateLimit({ windowMs: 15 * 60 * 1000, max: 15 }));
app.use("/api/auth/forgot-password", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
// SECURITY: the reset code is a 6-digit OTP valid 15 minutes — without a tight
// cap an attacker could brute-force it (full account takeover). 8 tries per
// window keeps legitimate users safe and makes guessing hopeless.
app.use("/api/auth/reset-password", rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));
app.use("/api/upload", rateLimit({ windowMs: 60 * 60 * 1000, max: 60 }));
app.use("/api/cloudinary", rateLimit({ windowMs: 60 * 60 * 1000, max: 30 }));
app.use("/api/subscription/chat", rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use("/api/subscription/submit-payment", rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }));
app.use("/api/payments/kashier/checkout", rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
app.use("/api/admin/declarations/unlock", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
// Messages: the UI polls the open conversation every few seconds plus thread
// list + unread badge — an IP-keyed bucket of 100 blocked real users within
// minutes. Key per-account with generous read headroom instead.
const messageKey = playerKey;
app.use("/api/messages", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
  key: messageKey,
  message: "طلبات مراسلة كثيرة جداً — انتظر قليلاً ثم أعد المحاولة"
}));
// Player endpoints. Browsing (list + profile detail) gets generous headroom:
// an authenticated club is counted per-account (never shares an IP bucket
// with other users) and can scout hundreds of profiles per window without
// being blocked. Write actions (create/update/delete/shortlist/review) keep
// a strict shared cap to prevent spam/abuse.
function playerKey(req) {
  const token = tokenFromRequest(req);
  if (token) {
    try {
      const payload = jwt.verify(token, SECRET);
      return "u:" + payload.id;
    } catch (e) {}
  }
  return "ip:" + (req.ip || req.socket.remoteAddress || "unknown");
}
const playersBrowse = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  key: playerKey,
  message: "طلبات كثيرة جداً — انتظر قليلاً ثم أعد المحاولة"
});
const playersWrite = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  key: playerKey,
  message: "طلبات كثيرة جداً — انتظر قليلاً ثم أعد المحاولة"
});
app.use("/api/players", (req, res, next) => {
  (req.method === "GET" ? playersBrowse : playersWrite)(req, res, next);
});

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/players", require("./routes/players.routes"));
app.use("/api/clubs", require("./routes/clubs.routes"));
app.use("/api/messages", require("./routes/messages.routes"));
app.use("/api/applications", require("./routes/applications.routes"));
// Direct-to-Cloudinary video upload (sign-up): /api/upload/direct/sign issues
// a signed permit, /confirm validates + records the CDN copy. Mounted BEFORE
// /api/upload so the more-specific path always wins.
//
// This path WAS covered by the generic /api/upload limiter above (60/h), but
// that cap is per-request on a tiny JSON body: the in-route permit cap (10
// outstanding/IP) and the byte quota only ever measured the JSON, while the
// actual video bytes went straight to Cloudinary. 20/h shared by /sign and
// /confirm keeps a single IP from cycling permits to fill the free Cloudinary
// quota (swept only after 26h).
app.use("/api/upload/direct", rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }));
app.use("/api/upload/direct", require("./routes/directUpload.routes"));
app.use("/api/upload", require("./routes/uploads.routes"));
app.use("/api/cloudinary", require("./routes/cloudinary.routes"));
app.use("/api/subscription", require("./routes/subscription.routes"));
app.use("/api/payments", require("./routes/payment.routes"));
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/admin/inquiries", require("./routes/inquiries.routes"));
app.use("/api/inquiries", require("./routes/inquiries.routes"));
app.use("/api/ai", require("./routes/ai.routes"));
app.use("/api/knowledge", require("./routes/knowledge.routes"));
app.use("/api/match", require("./routes/matching.routes"));

// ---------------------------------------------------------------------------
// SEO: server-rendered, crawlable profile pages + dynamic sitemap.
// Mounted BEFORE the static middleware so they win over the static files and
// so crawlers can index every approved player/club profile individually.
// ---------------------------------------------------------------------------
const seo = require("./seo");

app.get("/sitemap.xml", (req, res) => {
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=600");
  return res.send(seo.buildSitemap());
});

// Approved, public player profile — privacy-safe (no contact/docs) + JSON-LD.
app.get("/player/:slug", (req, res) => {
  const store = db.get();
  const slug = req.params.slug;
  const p = (store.players || []).find((x) => (x.slug || x.id) === slug);
  if (!p || !db.profileApproved(p)) {
    res.status(404).set("Content-Type", "text/html; charset=utf-8").send(seo.notFoundHtml());
    return;
  }
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(seo.playerProfileHtml(p));
});

// Approved, public club profile — privacy-safe + JSON-LD.
app.get("/club/:slug", (req, res) => {
  const store = db.get();
  const slug = req.params.slug;
  const c = (store.clubs || []).find((x) => (x.slug || x.id) === slug);
  if (!c || !db.profileApproved(c)) {
    res.status(404).set("Content-Type", "text/html; charset=utf-8").send(seo.notFoundHtml());
    return;
  }
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(seo.clubProfileHtml(c));
});

// Serve the front-end (roster/ folder) from the same server
app.use(express.static(path.join(__dirname, "..", "..", "roster"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  }
}));

// JSON 404 for unknown API routes
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Custom 404 page for broken frontend URLs
app.use((req, res) => {
  const page404 = path.join(__dirname, "..", "..", "roster", "404.html");
  if (fs.existsSync(page404)) return res.status(404).sendFile(page404);
  res.status(404).json({ error: "Page not found" });
});

// Error handler — never leak internal details to clients
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "الملف كبير جداً — الحد الأقصى: 1GB للفيديو و10MB للملفات الأخرى" });
  }
  res.status(err.status || 500).json({ error: "Server error" });
});

module.exports = app;