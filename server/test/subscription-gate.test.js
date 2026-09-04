/* Verify the mandatory-subscription-after-trial gate:
   - An EXPIRED (unpaid) account is blocked (402) from using the account:
     creating a profile, editing it, uploading files, adding videos.
   - An ACTIVE trial or ACTIVE paid account is allowed (201/200).
   - The payment + status endpoints stay OPEN so a lapsed user can still pay.
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".subgate-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const app = require("../src/app");

let server, base, failures = 0;
const auth = (role, id) => "Bearer " + sign({ id: id || role + "_x", role });

async function main() {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  const expId = "u_exp", trId = "u_tr", paId = "u_pa";
  if (!store.users.find((u) => u.id === expId)) {
    store.users.push({ id: expId, role: "player", name: "Exp", email: "exp@x.com", approved: true, subscriptionStatus: "expired", trialStart: new Date(Date.now() - 10 * 86400000).toISOString(), trialEnd: new Date(Date.now() - 3 * 86400000).toISOString() });
  }
  if (!store.users.find((u) => u.id === trId)) {
    store.users.push({ id: trId, role: "player", name: "Tr", email: "tr@x.com", approved: true, subscriptionStatus: "trialing", trialStart: new Date().toISOString(), trialEnd: new Date(Date.now() + 2 * 86400000).toISOString() });
  }
  if (!store.users.find((u) => u.id === paId)) {
    store.users.push({ id: paId, role: "player", name: "Pa", email: "pa@x.com", approved: true, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString() });
  }
  // A profile owned by the expired user (to test edit/delete gating).
  if (!store.players.find((p) => p.id === "p_exp")) {
    store.players.push({ id: "p_exp", userId: expId, name: "E", sport: "Football", currentClub: "X", approved: true, videos: [] });
  }
  db.save();

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const j = (body) => ({ "Content-Type": "application/json", Authorization: body._a }, body._b);
  const post = (url, id, obj) => fetch(base + url, { method: "POST", headers: { Authorization: auth("player", id), "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const put = (url, id, obj) => fetch(base + url, { method: "PUT", headers: { Authorization: auth("player", id), "Content-Type": "application/json" }, body: JSON.stringify(obj) });

  // 1) Expired -> 402 on profile creation
  let r = await post("/api/players", expId, { name: "X", sport: "Football" });
  assert.strictEqual(r.status, 402, "expired profile creation must be 402");
  console.log("PASS 1: expired trial blocks creating a profile (402)");

  // 2) Active trial -> 201
  r = await post("/api/players", trId, { name: "Y", sport: "Football" });
  assert.strictEqual(r.status, 201, "trial profile creation must be 201");
  console.log("PASS 2: active trial allows creating a profile (201)");

  // 3) Active paid -> 201
  r = await post("/api/players", paId, { name: "Z", sport: "Football" });
  assert.strictEqual(r.status, 201, "paid profile creation must be 201");
  console.log("PASS 3: active paid subscription allows creating a profile (201)");

  // 4) Expired -> 402 on editing own profile
  r = await put("/api/players/p_exp", expId, { name: "E2" });
  assert.strictEqual(r.status, 402, "expired profile edit must be 402");
  console.log("PASS 4: expired trial blocks editing a profile (402)");

  // 5) Expired -> 402 on authenticated upload (gate runs before multer)
  r = await fetch(base + "/api/upload", { method: "POST", headers: { Authorization: auth("player", expId) } });
  assert.strictEqual(r.status, 402, "expired upload must be 402");
  console.log("PASS 5: expired trial blocks file upload (402)");

  // 6) Expired -> 402 on adding a video
  r = await fetch(base + "/api/cloudinary/", { method: "POST", headers: { Authorization: auth("player", expId) } });
  assert.strictEqual(r.status, 402, "expired video add must be 402");
  console.log("PASS 6: expired trial blocks adding a video (402)");

  // 7) Payment endpoint stays OPEN for expired users (they must be able to pay)
  r = await fetch(base + "/api/subscription/submit-payment", { method: "POST", headers: { Authorization: auth("player", expId), "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.notStrictEqual(r.status, 402, "payment endpoint must stay open (not 402)");
  console.log("PASS 7: payment endpoint stays open for lapsed users (not 402)");

  // 7b) A lapsed user may still UPLOAD their payment receipt (purpose payment_receipt)
  const fd = new FormData();
  fd.append("file", new Blob(["x"], { type: "image/png" }), "receipt.png");
  fd.append("purpose", "payment_receipt");
  r = await fetch(base + "/api/upload", { method: "POST", headers: { Authorization: auth("player", expId) }, body: fd });
  assert.notStrictEqual(r.status, 402, "payment-receipt upload must stay open (not 402)");
  console.log("PASS 7b: lapsed user can still upload payment receipt (not 402)");

  // 8) Status endpoint stays OPEN
  r = await fetch(base + "/api/subscription/status", { headers: { Authorization: auth("player", expId) } });
  assert.strictEqual(r.status, 200, "status must stay open");
  console.log("PASS 8: subscription status stays open (200)");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
  console.log("\nSUBSCRIPTION GATE VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
