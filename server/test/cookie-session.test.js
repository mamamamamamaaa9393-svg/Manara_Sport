/* ==========================================================================
   E2E: JWT now lives in an httpOnly cookie (server-set), not in JS storage.
   Verifies the full login → protected-access → logout cycle over the cookie:
     • /login sets manara_token with HttpOnly + Path=/ (+ SameSite=Lax)
     • the cookie alone authenticates protected endpoints (no Authorization header)
     • without the cookie the same endpoints return 401
     • wrong/empty credentials never set a cookie
     • /logout clears the cookie and the session dies
     • private media & message endpoints honor the cookie session
   Runs against the in-process app on an mongo-less JSON store (db.json is
   backed up and restored).
   ========================================================================== */
// Load the real .env so the app boots (VAULT_PASSPHRASE etc.) even when the
// test is run directly with `node test/cookie-session.test.js`.
try { require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch (e) {}

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".cookie-test-backup";
const hasDb = fs.existsSync(DB_FILE);
if (hasDb) fs.copyFileSync(DB_FILE, BACKUP);

const db = require("../src/db");
const app = require("../src/app");

let server;
let base;
let pass = 0, fail = 0;

function t(name, cond, extra) {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// http.request wrapper — full control of headers so we can read Set-Cookie
// and replay the Cookie header exactly like a browser would (minus the part JS
// can't see: HttpOnly is transparent to the network layer).
function req(method, p, body, cookie, authHeader) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    if (authHeader) headers["Authorization"] = "Bearer " + authHeader;
    const r = http.request({ method, hostname: "127.0.0.1", port: server.address().port, path: p, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, data: j, raw: d, setCookies: res.headers["set-cookie"] || [] });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// Pull the manara_token cookie from a response's Set-Cookie headers.
function cookieInfo(resp) {
  const sc = (resp.setCookies || []).find((c) => c.startsWith("manara_token="));
  if (!sc) return null;
  return {
    token: sc.split(";")[0],
    httpOnly: /;\s*HttpOnly/i.test(sc),
    sameSiteLax: /;\s*SameSite=Lax/i.test(sc),
    secure: /;\s*Secure/i.test(sc),
    pathRoot: /;\s*Path=\//i.test(sc)
  };
}

(async () => {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  store.players = store.players || [];
  store.messages = store.messages || [];

  const uid = "u_cookie_player";
  const email = "cookie@test.app";
  const password = "secret123";
  const hash = await bcrypt.hash(password, 10);

  if (!store.users.find((u) => u.id === uid)) {
    store.users.push({
      id: uid, role: "player", name: "Cookie Tester", email, passwordHash: hash,
      approved: true, subscriptionStatus: "active",
      subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString()
    });
  }
  db.save();

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // ---- 1. login success sets the httpOnly cookie ----
  let r = await req("POST", "/api/auth/login", { email, password });
  const ck = cookieInfo(r);
  t("login returns 200", r.status === 200, r);
  t("login issues manara_token cookie", !!ck, r.setCookies);
  t("cookie is HttpOnly (JS-invisible)", !!(ck && ck.httpOnly), ck);
  t("cookie scoped to Path=/", !!(ck && ck.pathRoot), ck);
  t("cookie carries SameSite=Lax", !!(ck && ck.sameSiteLax), ck);
  // On plain-HTTP dev the cookie must NOT force Secure (else browsers drop it).
  t("cookie is non-Secure on HTTP (dev)", !!(ck && !ck.secure), ck);

  const cookie = ck ? ck.token : "";

  // ---- 2. protected endpoint works with the COOKIE ONLY (no header) ----
  r = await req("GET", "/api/auth/me", null, cookie);
  t("/auth/me via cookie only -> 200", r.status === 200, r);
  t("cookie session resolves the right user", r.status === 200 && r.data && r.data.user && r.data.user.id === uid, r.data && r.data.user);

  // ---- 3. without the cookie (no auth at all) -> 401 ----
  r = await req("GET", "/api/auth/me");
  t("no cookie, no header -> 401", r.status === 401, r);

  // ---- 4. wrong password does NOT set a cookie ----
  r = await req("POST", "/api/auth/login", { email, password: "wrongpass" });
  t("bad credentials -> 401", r.status === 401, r);
  t("bad credentials set no cookie", cookieInfo(r) === null, r.setCookies);

  // ---- 5. messages endpoint: protected via cookie ----
  r = await req("GET", "/api/messages/threads", null, cookie);
  t("message threads via cookie -> 200", r.status === 200, r);
  r = await req("GET", "/api/messages/threads");
  t("message threads without cookie -> 401", r.status === 401, r);

  // ---- 6. admin guard still enforced (cookie session of a non-admin) ----
  r = await req("GET", "/api/admin/registrations?status=pending", null, cookie);
  t("non-admin blocked from admin API (not 200)", r.status !== 200, r);

  // ---- 7. private upload path honors the cookie session ----
  // A private document none exists; asserting it's *not* served publicly and
  // that the authenticated request at least passes the auth gate is enough.
  r = await req("GET", "/uploads/some-private-doc.png");
  t("private upload not public (auth gate)", r.status === 401 || r.status === 403 || r.status === 404, r.status);
  r = await req("GET", "/uploads/some-private-doc.png", null, cookie);
  t("private upload auth gate passes with cookie (no 401)", r.status !== 401, r.status);

  // ---- 8. logout clears the cookie -> session dies ----
  r = await req("POST", "/api/auth/logout", {}, cookie);
  const clearCK = cookieInfo(r);
  t("logout returns 200", r.status === 200, r);
  // clear cookie carries an empty/expired value
  const isCleared = (r.setCookies || []).some((c) => c.startsWith("manara_token=") && (/Expires=/i.test(c) || /Max-Age=0/i.test(c) || c.split(";")[0].indexOf("=") === c.split(";")[0].length - 1));
  t("logout clears the cookie", r.status === 200 && isCleared, r.setCookies);

  // The old cookie value should no longer authenticate.
  r = await req("GET", "/api/auth/me", null, cookie);
  t("session dead after logout (401)", r.status === 401, r);

  // ---- 9. guarded account deletion via cookie ----
  await req("POST", "/api/auth/login", { email, password });
  r = await req("GET", "/api/auth/me", null, cookie);
  // Re-issue a fresh cookie by logging in again and capturing the new token
  r = await req("POST", "/api/auth/login", { email, password });
  const ck2 = cookieInfo(r);
  t("second login issues a fresh cookie", !!ck2, r.setCookies);
  if (ck2) {
    r = await req("DELETE", "/api/auth/account", null, ck2.token);
    t("account deletion via cookie -> success", r.status === 200, r);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  server.close();
  if (hasDb) fs.copyFileSync(BACKUP, DB_FILE);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  if (hasDb) fs.copyFileSync(BACKUP, DB_FILE);
  process.exit(1);
});
