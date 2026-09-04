/* Regression test — club profile write routes are now subject to the same
   mandatory-subscription-after-trial gate as player profiles (H1 fix):
     - An ACTIVE club trial or ACTIVE paid club may POST/PUT (and DELETE) its
       own club profile.
     - An EXPIRED (unpaid) club is blocked (402) from POST/PUT/DELETE.
     - An ADMIN may always DELETE a club (the admin is exempt from the paywall),
       so the owner-or-admin delete path still works for moderators.
     - Payment / renewal / receipt-upload / status endpoints STAY open (not 402)
       for a lapsed club so it can still subscribe.
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".clubpaywall-test-backup";
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
  store.clubs = store.clubs || [];

  const ids = {
    exp: "u_c_exp",   // expired trial club
    tr: "u_c_tr",     // active trial club
    pa: "u_c_pa",     // active paid club
    admin: "u_c_admin"
  };
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const mk = (id, role, sub) => Object.assign(
    { id, role, name: id, approved: true },
    sub
  );
  // Active trial club (7-day club trial, still live).
  store.users.push(mk(ids.tr, "club", { subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 7 * 86400000) }));
  // Expired trial club.
  store.users.push(mk(ids.exp, "club", { subscriptionStatus: "expired", trialStart: iso(now - 10 * 86400000), trialEnd: iso(now - 3 * 86400000) }));
  // Active paid club.
  store.users.push(mk(ids.pa, "club", { subscriptionStatus: "active", subscriptionExpiresAt: iso(now + 10 * 86400000) }));
  // Admin account.
  store.users.push(mk(ids.admin, "admin", {}));

  // A pre-existing club owned by the expired user (to test edit/delete gating).
  if (!store.clubs.find((c) => c.id === "c_exp")) {
    store.clubs.push({ id: "c_exp", userId: ids.exp, name: "Expired Club", sport: "Football", keywords: "expired club" });
  }
  db.save();

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const post = (url, id, obj) => fetch(base + url, { method: "POST", headers: { Authorization: auth("club", id), "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const put = (url, id, obj) => fetch(base + url, { method: "PUT", headers: { Authorization: auth("club", id), "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const del = (url, id) => fetch(base + url, { method: "DELETE", headers: { Authorization: auth("club", id) } });

  // 1) Expired club -> 402 on creating a club profile.
  let r = await post("/api/clubs", ids.exp, { name: "X", sport: "Football" });
  assert.strictEqual(r.status, 402, "expired club create must be 402");
  let b = await r.json();
  assert.strictEqual(b.code, "SUBSCRIPTION_REQUIRED", "402 must carry SUBSCRIPTION_REQUIRED");
  console.log("PASS 1: expired club blocked from creating a club profile (402)");

  // 2) Active trial club -> 201 (record the generated id for the edit/delete checks).
  r = await post("/api/clubs", ids.tr, { name: "Y", sport: "Football" });
  assert.strictEqual(r.status, 201, "trial club create must be 201");
  let trialClub = (await r.json()).club;
  assert.ok(trialClub && trialClub.id, "created trial club must carry an id");
  console.log("PASS 2: active trial club can create a club profile (201)");

  // 3) Active paid club -> 201.
  r = await post("/api/clubs", ids.pa, { name: "Z", sport: "Football" });
  assert.strictEqual(r.status, 201, "paid club create must be 201");
  console.log("PASS 3: active paid club can create a club profile (201)");

  // 4) Expired club -> 402 on editing its own club profile (even before ownership).
  r = await put("/api/clubs/c_exp", ids.exp, { name: "E2" });
  assert.strictEqual(r.status, 402, "expired club edit must be 402");
  console.log("PASS 4: expired club blocked from editing its club profile (402)");

  // 5) Expired club -> 402 on deleting a club.
  r = await del("/api/clubs/c_exp", ids.exp);
  assert.strictEqual(r.status, 402, "expired club delete must be 402");
  console.log("PASS 5: expired club blocked from deleting a club (402)");

  // 6) Active trial club can edit the club profile it just created -> 200.
  r = await put("/api/clubs/" + trialClub.id, ids.tr, { name: "Trial Club Updated" });
  assert.strictEqual(r.status, 200, "trial club edit must be 200");
  console.log("PASS 6: active trial club can edit its club profile (200)");

  // 7) Active trial club can delete the club profile it just created -> 200.
  r = await del("/api/clubs/" + trialClub.id, ids.tr);
  assert.strictEqual(r.status, 200, "trial club delete must be 200");
  console.log("PASS 7: active trial club can delete its club profile (200)");

  // 8) Admin can delete a club regardless of the owner's subscription state.
  //    (requireActiveSub passes because the ADMIN is exempt from the paywall.)
  r = await fetch(base + "/api/clubs/c_exp", { method: "DELETE", headers: { Authorization: auth("admin", ids.admin) } });
  assert.strictEqual(r.status, 200, "admin delete of expired-owned club must be 200");
  console.log("PASS 8: admin can always delete a club (200)");

  // 9) A lapsed (expired) club can still SUBMIT PAYMENT (not 402).
  r = await fetch(base + "/api/subscription/submit-payment", { method: "POST", headers: { Authorization: auth("club", ids.exp), "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.notStrictEqual(r.status, 402, "payment endpoint must stay open (not 402)");
  console.log("PASS 9: lapsed club can still reach the payment endpoint (not 402)");

  // 10) A lapsed club can still UPLOAD its payment receipt (not 402).
  const fd = new FormData();
  fd.append("file", new Blob(["x"], { type: "image/png" }), "receipt.png");
  fd.append("purpose", "payment_receipt");
  r = await fetch(base + "/api/upload", { method: "POST", headers: { Authorization: auth("club", ids.exp) }, body: fd });
  assert.notStrictEqual(r.status, 402, "payment-receipt upload must stay open (not 402)");
  console.log("PASS 10: lapsed club can still upload payment receipt (not 402)");

  // 11) Subscription status stays OPEN (200).
  r = await fetch(base + "/api/subscription/status", { headers: { Authorization: auth("club", ids.exp) } });
  assert.strictEqual(r.status, 200, "status must stay open");
  console.log("PASS 11: subscription status stays open for lapsed club (200)");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
  console.log("\nCLUB PAYWALL FIX VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
