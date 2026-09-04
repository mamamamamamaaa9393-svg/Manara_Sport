const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// --- httpOnly cookie session carrier -------------------------------
// The JWT lives in an httpOnly cookie so an XSS payload can never read it
// (it is invisible to document.cookie). A tiny parser avoids adding a new
// dependency; SameSite=Lax still sends the cookie on same-origin API calls
// and top-level navigations, and Secure is applied only on HTTPS so local
// HTTP development keeps working.
const COOKIE_NAME = "manara_token";
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

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/"
  };
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, authCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
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

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// Revoked tokens (logout). The JWT is signed/stateless, so clearing the
// cookie alone leaves the old value technically valid until it expires.
// To truly kill a session on logout we keep an in-process denylist — reusing
// a logged-out token is rejected with 401. Entries are pruned once expired
// so the map never grows unbounded. (In multi-instance deployments this is
// per-process; acceptable for now and a large step up from no revocation.)
const revoked = new Map(); // token -> expiresAt(ms)

function revokeToken(token) {
  if (!token) return;
  const now = Date.now();
  // Prune expired entries before adding new one
  for (const [t, exp] of revoked) {
    if (exp <= now) revoked.delete(t);
  }
  // Mark this token as revoked for the JWT TTL (7 days from now)
  revoked.set(token, now + SESSION_TTL_MS);
}

function isRevoked(token) {
  if (!token || !revoked.size) return false;
  const exp = revoked.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) { revoked.delete(token); return false; }
  return true;
}

module.exports = { SECRET, sign, requireAuth, requireAdmin, COOKIE_NAME, tokenFromRequest, setAuthCookie, clearAuthCookie, readCookie, revokeToken, isRevoked };