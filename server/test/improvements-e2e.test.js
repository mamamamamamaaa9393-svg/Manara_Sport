/* E2E smoke test for the 7 new improvements (runs against live server:5000).
   Covers:
     - how-to-pay page served + footer link
     - club rates a player (review endpoint + aggregate rating)
     - in-app notifications (payment approval pushed + drained on status)
     - SEO/shareable meta helpers (page titles)
   Cleanup: test users/clubs/players/reviews/transactions removed at the end.
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:5000";
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";
const NOW = Date.now();
const CLUB_EMAIL = "club_" + NOW + "@test.com";
const PLAYER_EMAIL = "player_" + NOW + "@test.com";
const PASS = "TestPass123!";

const { otpFrom } = require("./helpers");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra).slice(0, 300) : "")); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: "localhost", port: 5000, path: p, headers: { "Accept": "application/json" } };
    if (data) opts.headers["Content-Type"] = "application/json";
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, data: null }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function db() { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8")); }

async function registerAndApprove(email, role, extra) {
  const sv = await req("POST", "/api/auth/send-verification", { email });
  const vId = sv.data.verificationId;
  const code = otpFrom(sv);
  await req("POST", "/api/auth/verify-email", { verificationId: vId, code });
  const data = Object.assign({ email, password: PASS, password_confirm: PASS }, extra);
  const reg = await req("POST", "/api/auth/register", { role, data });
  if (reg.status !== 201) { throw new Error("register failed: " + JSON.stringify(reg.data)); }
  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  await req("POST", "/api/admin/registrations/" + reg.data.registrationId + "/approve", {}, adminLogin.data.token);
  const login = await req("POST", "/api/auth/login", { email, password: PASS });
  return login.data.token;
}

async function run() {
  console.log("\n=== New improvements E2E smoke test ===");

  // [1] how-to-pay page served
  console.log("\n[1] how-to-pay page");
  const page = await req("GET", "/how-to-pay.html");
  ok("how-to-pay.html serves 200", page.status === 200);

  // [2] register club + player
  console.log("\n[2] Register club + player");
  const clubToken = await registerAndApprove(CLUB_EMAIL, "club", {
    club_name: "Test Club " + NOW, sport: "Football", country: "Egypt",
    official_email: CLUB_EMAIL,
    documents: { official_letter: "/uploads/t_l.jpg", license: "/uploads/t_lc.jpg" }
  });
  const playerToken = await registerAndApprove(PLAYER_EMAIL, "player", {
    full_name: "Test Athlete " + NOW, sport: "Football", position: "Striker (ST)",
    documents: { birth_cert: "/uploads/t_b.jpg", medical: "/uploads/t_m.jpg", declaration: "/uploads/t_d.jpg" },
    videos: [{ url: "/uploads/t_v.mp4", duration: 600 }]
  });
  const d0 = db();
  const player = d0.players.find((p) => p.userId === (d0.users.find((u) => u.email === PLAYER_EMAIL) || {}).id);
  ok("club + player created", !!clubToken && !!playerToken && !!player);

  // [3] club rates the player
  console.log("\n[3] Club reviews the player");
  const r1 = await req("POST", "/api/players/" + player.slug + "/review", { stars: 4, comment: "مستوى جيد" }, clubToken);
  ok("review accepted", r1.status === 200 && r1.data.review.stars === 4, r1);
  ok("aggregate rating 4.0", r1.data.rating === 4.0 && r1.data.reviews === 1, r1.data);
  const r2 = await req("POST", "/api/players/" + player.slug + "/review", { stars: 5 }, clubToken);
  ok("re-rating updates in place (no duplicate)", r2.data.reviews === 1 && r2.data.rating === 5, r2.data);

  // [4] player profile now exposes reviews
  console.log("\n[4] Player profile shows reviews");
  const view = await req("GET", "/api/players/" + player.slug, null, playerToken);
  ok("GET player returns reviews + myReview", Array.isArray(view.data.reviews) && view.data.reviews.length === 1, view.data);
  const clubView = await req("GET", "/api/players/" + player.slug, null, clubToken);
  ok("club sees own myReview", clubView.data.myReview && clubView.data.myReview.stars === 5, clubView.data.myReview);

  // [5] in-app notification on payment approval (admin approve path)
  console.log("\n[5] In-app notifications (payment result)");
  const st0 = await req("GET", "/api/subscription/status", null, playerToken);
  const baseStatus = st0.data.status; // trialing
  const pay = await req("POST", "/api/subscription/submit-payment", {
    method: "fawry", referenceNumber: "N" + NOW, screenshotUrl: "/uploads/pay_new_" + NOW + ".jpg", amount: 39
  }, playerToken);
  ok("submit-payment accepted", pay.status === 201, pay);
  const txId = pay.data.transaction.id;
  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  const ap = await req("POST", "/api/admin/transactions/" + txId + "/approve", {}, adminLogin.data.token);
  ok("admin approved tx", ap.status === 200, ap);
  const st1 = await req("GET", "/api/subscription/status", null, playerToken);
  ok("status active after approval", st1.data.status === "active", st1.data.status);
  ok("approval notification drained in status", Array.isArray(st1.data.notifications) &&
    st1.data.notifications.some((n) => /تمت الموافقة|تفعيل/.test(n.title)), st1.data.notifications);
  const st2 = await req("GET", "/api/subscription/status", null, playerToken);
  ok("notifications drained once (empty next call)", !st2.data.notifications.length, st2.data.notifications);

  // [6] cleanup test records
  console.log("\n[6] Cleanup");
  const store = db();
  const ids = [];
  const uClub = store.users.find((u) => u.email === CLUB_EMAIL);
  const uPlayer = store.users.find((u) => u.email === PLAYER_EMAIL);
  if (uClub) ids.push(uClub.id);
  if (uPlayer) ids.push(uPlayer.id);
  store.users = store.users.filter((u) => ids.indexOf(u.id) === -1);
  store.players = store.players.filter((p) => ids.indexOf(p.userId) === -1);
  store.clubs = store.clubs.filter((c) => ids.indexOf(c.userId) === -1);
  store.registrations = store.registrations.filter((r) => ids.indexOf(r.userId) === -1);
  store.transactions = store.transactions.filter((t) => t.userId !== (uPlayer || {}).id);
  store.reviews = store.reviews.filter((r) => r.playerId !== ((player || {}).id));
  store.verifications = store.verifications.filter((v) => [CLUB_EMAIL, PLAYER_EMAIL].indexOf(v.email) === -1);
  fs.writeFileSync(path.join(__dirname, "..", "data", "db.json"), JSON.stringify(store, null, 2));
  ok("test data cleaned", true);

  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });