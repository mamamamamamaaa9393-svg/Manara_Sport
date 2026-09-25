const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../db");

// --- httpOnly cookie session carrier -------------------------------
// The JWT lives in an httpOnly cookie so an XSS payload can never read it
// (it is invisible to document.cookie). A tiny parser avoids adding a new
// dependency; SameSite=Lax still sends the cookie on same-origin API calls
// and top-level navigations, and Secure is applied only on HTTPS so local
// HTTP development keeps working.
const COOKIE_NAME = "manara_token";
const CSRF_COOKIE = "manara_csrf";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches sign() expiresIn

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

// Order matters: the Authorization header keeps working (backwards compatible
// for API clients / tests that call sign() directly), but when a browser is
// used the httpOnly cookie is the source of truth and the header is ignored.
function tokenFromRequest(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return readCookie(req, COOKIE_NAME);
}

function secureCookies() {
  return process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
}

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/"
  };
}

// The CSRF cookie carries the double-submit token. It is NOT httpOnly on
// purpose: JavaScript must read it back to attach the X-CSRF-Token header,
// which is exactly what defeats cross-site submission forgery.
function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: secureCookies(),
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/"
  };
}

function newCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, authCookieOptions());
  // Fresh session -> fresh CSRF token. Every login rotates both.
  res.cookie(CSRF_COOKIE, newCsrfToken(), csrfCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.clearCookie(CSRF_COOKIE, { path: "/" });
}

// Never use a known default secret. In production require JWT_SECRET.
// In development generate a random per-machine secret persisted to
// server/data/.dev_secret so tokens survive server restarts.
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  const secretFile = path.join(__dirname, "..", "..", "data", ".dev_secret");
  try {
    SECRET = fs.readFileSync(secretFile, "utf8").trim();
  } catch (e) {
    SECRET = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, SECRET);
  }
}

function sign(user) {
  // Unique per-login id (jti) so two logins within the same second never
  // produce byte-identical tokens. Without it, logout of one session revoked
  // every other token minted in the same second (they shared the same string).
  return jwt.sign(
    { id: user.id, role: user.role, jti: crypto.randomBytes(16).toString("hex") },
    SECRET,
    { expiresIn: "7d" }
  );
}

function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  // SECURITY: a logged-out (revoked) token must be rejected even though its
  // signature is still valid. Check the denylist before verifying so that
  // reusing an old cookie after logout returns 401 instead of 200.
  if (isRevoked(token)) {
    return res.status(401).json({ error: "Session expired, please log in again" });
  }
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Revoked tokens (logout). The JWT is signed/stateless, so clearing the cookie
// alone leaves the old value technically valid until it expires.
//
// The denylist is both an IN-MEMORY Map (fast path) AND a persisted list on
// the data store (revoked_tokens). Persisting means a logout survives a server
// restart: previously a process restart silently resurrected every logged-out
// token for up to its whole 7-day TTL. The store is hydrated lazily on the
// first check so a module load before db.init() is harmless.
// ---------------------------------------------------------------------------
const revoked = new Map(); // token -> expiresAt(ms)
let revokedHydrated = false;

function revokedAsList(store) {
  const list = [];
  const now = Date.now();
  for (const r of (store && Array.isArray(store.revoked_tokens) ? store.revoked_tokens : [])) {
    if (!r || typeof r.token !== "string") continue;
    const exp = Number(r.expiresAt);
    if (!Number.isFinite(exp) || exp <= now) continue; // expired are dropped here
    list.push({ token: r.token, expiresAt: exp });
  }
  return list;
}

function ensureRevokedHydrated() {
  if (revokedHydrated) return;
  revokedHydrated = true;
  let store = null;
  try { store = db.get(); } catch (e) {}
  if (!store) return;
  const now = Date.now();
  for (const r of revokedAsList(store)) revoked.set(r.token, r.expiresAt);
}

function persistRevoked(list) {
  try {
    const store = db.get();
    if (!store || !Array.isArray(store.revoked_tokens)) return;
    store.revoked_tokens = list;
    db.save();
  } catch (e) { /* storage unavailable -> in-memory only (previous behaviour) */ }
}

function revokeToken(token) {
  if (!token) return;
  const now = Date.now();
  ensureRevokedHydrated();
  // Prune expired entries before adding the new one (Map + store stay bounded
  // to the 7-day TTL window — anything older is dropped on the next logout).
  for (const [t, exp] of revoked) {
    if (exp <= now) revoked.delete(t);
  }
  revoked.set(token, now + SESSION_TTL_MS);
  const list = [];
  for (const [t, exp] of revoked) list.push({ token: t, expiresAt: exp });
  persistRevoked(list);
}

function isRevoked(token) {
  if (!token) return false;
  ensureRevokedHydrated();
  const exp = revoked.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) { revoked.delete(token); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// CSRF protection (double-submit cookie pattern).
//
// The only requests that can be forged cross-site are ones carrying a session:
// browsers refuse to attach SameSite=Lax cookies to cross-site POSTs, and a
// cross-origin fetch with credentials against this server is blocked by CORS
// (dev is origin "*" + credentials false; production is an explicit allowlist).
// As defence-in-depth we additionally require the custom header X-CSRF-Token
// to match the manara_csrf cookie for every cookie-authenticated state change.
// Requests authenticated ONLY via the Authorization header (API clients, the
// test suite) never carry the cookie, so they are untouched and stay working.
//
// The CSRF cookie is planted lazily on safe (GET) requests whenever a session
// cookie exists, which makes the rollout seamless for sessions created before
// this feature existed: the next page load or /auth/me call plants it, and the
// frontend then sends the header on every state-changing call.
// ---------------------------------------------------------------------------
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function plantCsrfIfMissing(req, res) {
  if (readCookie(req, CSRF_COOKIE)) return;
  if (!readCookie(req, COOKIE_NAME)) return;
  res.cookie(CSRF_COOKIE, newCsrfToken(), csrfCookieOptions());
}

function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    plantCsrfIfMissing(req, res);
    return next();
  }
  // No session cookie -> nothing to hijack; let requireAuth decide auth.
  if (!readCookie(req, COOKIE_NAME)) return next();
  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: "CSRF token missing or invalid — قم بتحديث الصفحة أو أعد تسجيل الدخول" });
  }
  next();
}

module.exports = { SECRET, sign, requireAuth, requireAdmin, COOKIE_NAME, CSRF_COOKIE, tokenFromRequest, setAuthCookie, clearAuthCookie, readCookie, revokeToken, isRevoked, csrfProtect, csrfCookieOptions, newCsrfToken };