/* Verify the MANDATORY paywall for lapsed (unpaid, trial-ended) accounts:
   - An EXPIRED (unpaid) account is blocked (402) from:
       * the AI assistant chat
       * sending + reading messages
       * viewing its OWN profile
   - An ACTIVE trial or ACTIVE paid account is allowed (not 402).
   - After the subscription is activated (payment), everything unlocks (200).
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".paywall-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const app = require("../src/app");

let server, base;
const auth = (role, id) => "Bearer " + sign({ id: id || role + "_x", role });

async function main() {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  store.players = store.players || [];

  const expId = "u_pay_exp", trId = "u_pay_tr", paId = "u_pay_pa", clubId = "u_pay_club";

  if (!store.users.find((u) => u.id === expId)) {
    store.users.push({ id: expId, role: "player", name: "Exp", email: "exp@x.com", approved: true, subscriptionStatus: "expired", trialStart: new Date(Date.now() - 10 * 86400000).toISOString(), trialEnd: new Date(Date.now() - 3 * 86400000).toISOString() });
  }
  if (!store.users.find((u) => u.id === trId)) {
    store.users.push({ id: trId, role: "player", name: "Tr", email: "tr@x.com", approved: true, subscriptionStatus: "trialing", trialStart: new Date().toISOString(), trialEnd: new Date(Date.now() + 2 * 86400000).toISOString() });
  }
  if (!store.users.find((u) => u.id === paId)) {
    store.users.push({ id: paId, role: "player", name: "Pa", email: "pa@x.com", approved: true, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString() });
  }
  if (!store.users.find((u) => u.id === clubId)) {
    store.users.push({ id: clubId, role: "club", name: "Club", email: "club@x.com", approved: true, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString() });
  }
  if (!store.players.find((p) => p.id === "p_pay_own_exp")) {
    store.players.push({ id: "p_pay_own_exp", userId: expId, name: "E", sport: "Football", currentClub: "X", approved: true, videos: [] });
  }
  if (!store.players.find((p) => p.id === "p_pay_own_tr")) {
    store.players.push({ id: "p_pay_own_tr", userId: trId, name: "T", sport: "Football", currentClub: "Y", approved: true, videos: [] });
  }
  db.save();

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const post = (url, id, obj) => fetch(base + url, { method: "POST", headers: { Authorization: auth("player", id), "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const get = (url, id) => fetch(base + url, { headers: { Authorization: auth(id ? "player" : "player", id || expId) } });

  // ---- AI ASSISTANT ----
  // Expired -> 402
  let r = await post("/api/ai/chat", expId, { message: "من أنا؟" });
  assert.strictEqual(r.status, 402, "expired AI chat must be 402");
  console.log("PASS A1: expired trial blocks AI assistant (402)");
  let body = await r.json();
  assert.strictEqual(body.code, "SUBSCRIPTION_REQUIRED", "AI 402 must carry SUBSCRIPTION_REQUIRED");

  // Trial -> not 402 (allowed)
  r = await post("/api/ai/chat", trId, { message: "من أنا؟" });
  assert.notStrictEqual(r.status, 402, "trial AI chat must not be 402");
  console.log("PASS A2: active trial allows AI assistant (not 402)");

  // Active paid -> not 402
  r = await post("/api/ai/chat", paId, { message: "من أنا؟" });
  assert.notStrictEqual(r.status, 402, "paid AI chat must not be 402");
  console.log("PASS A3: active paid allows AI assistant (not 402)");

  // ---- MESSAGES ----
  // Expired send -> 402
  r = await post("/api/messages", expId, { toUserId: clubId, text: "مرحبا" });
  assert.strictEqual(r.status, 402, "expired send message must be 402");
  console.log("PASS M1: expired trial blocks sending messages (402)");

  // Expired threads -> 402
  r = await fetch(base + "/api/messages/threads", { headers: { Authorization: auth("player", expId) } });
  assert.strictEqual(r.status, 402, "expired message threads must be 402");
  console.log("PASS M2: expired trial blocks reading messages (402)");

  // Trial send -> not 402 (subscription gate passes; may hit other rules)
  r = await post("/api/messages", trId, { toUserId: clubId, text: "مرحبا" });
  assert.notStrictEqual(r.status, 402, "trial send must not be 402");
  console.log("PASS M3: active trial allows sending messages (not 402)");

  // Trial threads -> not 402
  r = await fetch(base + "/api/messages/threads", { headers: { Authorization: auth("player", trId) } });
  assert.notStrictEqual(r.status, 402, "trial threads must not be 402");
  console.log("PASS M4: active trial allows reading messages (not 402)");

  // ---- OWN PROFILE ----
  // Expired owner -> 402
  r = await fetch(base + "/api/players/p_pay_own_exp", { headers: { Authorization: auth("player", expId) } });
  assert.strictEqual(r.status, 402, "expired own-profile view must be 402");
  console.log("PASS P1: expired trial blocks viewing own profile (402)");

  // Trial owner -> 200
  r = await fetch(base + "/api/players/p_pay_own_tr", { headers: { Authorization: auth("player", trId) } });
  assert.strictEqual(r.status, 200, "trial own-profile view must be 200");
  console.log("PASS P2: active trial allows viewing own profile (200)");

  // ---- UNLOCK AFTER PAYMENT ----
  const me = store.users.find((u) => u.id === expId);
  me.subscriptionStatus = "active";
  me.subscriptionExpiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  me.trialEnd = new Date(Date.now() + 30 * 86400000).toISOString();
  db.save();
  r = await fetch(base + "/api/players/p_pay_own_exp", { headers: { Authorization: auth("player", expId) } });
  assert.strictEqual(r.status, 200, "after payment, own-profile must unlock (200)");
  console.log("PASS U1: after payment, own profile unlocks (200)");
  r = await post("/api/ai/chat", expId, { message: "من أنا؟" });
  assert.notStrictEqual(r.status, 402, "after payment, AI must unlock (not 402)");
  console.log("PASS U2: after payment, AI assistant unlocks (not 402)");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  console.log("\nPAYWALL VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
