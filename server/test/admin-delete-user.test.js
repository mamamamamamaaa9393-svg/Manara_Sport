/* Verify the admin-only permanent account-deletion feature:
   - A non-admin (player) is blocked (403).
   - An admin can delete a targeted user and EVERYTHING tied to that account:
     player profile, messages, registrations, transactions + receipt files,
     reviews, profile views, AI chats, applications, shortlist/scout-note
     references, AND the local uploaded image/video files are physically removed.
   - An admin account cannot be deleted (403).
   - An admin cannot delete their own account (403).
   - Deleting a missing account -> 404.
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".admindelete-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

// Stub Cloudinary so the route's remote deletion can be verified without a network call.
process.env.CLOUDINARY_CLOUD_NAME = "test";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";
const cloud = require("cloudinary").v2;
const destroyedCloudIds = [];
cloud.uploader.destroy = (pid) => { destroyedCloudIds.push(pid); return Promise.resolve({ result: "ok" }); };

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const app = require("../src/app");

const UP = path.join(__dirname, "..", "uploads");
const F1 = "del_test_player.png";
const F2 = "del_test_tx.png";

let server, base;
const adminTok = "Bearer " + sign({ id: "u_admin", role: "admin" });
const playerTok = "Bearer " + sign({ id: "u_intruder", role: "player" });
const authH = (t) => ({ Authorization: t, "Content-Type": "application/json" });
const del = (id, t) => fetch(base + "/api/admin/users/" + id, { method: "DELETE", headers: authH(t) });

async function main() {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  store.players = store.players || [];
  store.clubs = store.clubs || [];
  store.messages = store.messages || [];
  store.registrations = store.registrations || [];
  store.transactions = store.transactions || [];
  store.ai_chats = store.ai_chats || [];
  store.reviews = store.reviews || [];
  store.profile_views = store.profile_views || [];
  store.applications = store.applications || [];
  store.uploads = store.uploads || [];

  if (!store.users.find((u) => u.id === "u_admin")) store.users.push({ id: "u_admin", role: "admin", name: "Admin", approved: true });
  if (!store.users.find((u) => u.id === "u_admin2")) store.users.push({ id: "u_admin2", role: "admin", name: "Admin2", approved: true });
  if (!store.users.find((u) => u.id === "u_intruder")) store.users.push({ id: "u_intruder", role: "player", name: "Intruder", approved: true });
  if (!store.users.find((u) => u.id === "u_target")) store.users.push({ id: "u_target", role: "player", name: "Target", approved: true });
  if (!store.users.find((u) => u.id === "u_other")) store.users.push({ id: "u_other", role: "club", name: "Other", approved: true });

  const pTarget = "p_target";
  if (!store.players.find((p) => p.id === pTarget)) {
    store.players.push({
      id: pTarget, userId: "u_target", slug: "del-target", name: "Target", sport: "Football", photo: "/uploads/" + F1,
      videos: [{ id: "vid_del", publicId: "manara/users/u_target/videos/abc123", url: "https://res.cloudinary.com/demo/video/upload/v1/manara/users/u_target/videos/abc123.mp4" }]
    });
  }
  if (!store.clubs.find((c) => c.id === "c_other")) {
    store.clubs.push({ id: "c_other", userId: "u_other", name: "Other", shortlist: [pTarget], scoutNotes: { [pTarget]: "note" } });
  }
  store.messages.push({ id: "m_del", fromUserId: "u_target", toUserId: "u_other", text: "hi", createdAt: new Date().toISOString() });
  store.registrations.push({ id: "reg_del", userId: "u_target", status: "approved", name: "Target", email: "t@x.com", role: "player", data: {}, submittedAt: new Date().toISOString() });
  store.transactions.push({ id: "tx_del", userId: "u_target", status: "pending", transactionScreenshot: "/uploads/" + F2 });
  store.ai_chats.push({ id: "ac_del", user_id: "u_target", is_revealed: false });
  store.reviews.push({ id: "rv_del", playerId: pTarget, clubUserId: "u_other" });
  store.profile_views.push({ playerId: pTarget, viewerUserId: "u_other", at: new Date().toISOString() });
  store.applications.push({ id: "ap_del", playerId: pTarget, clubUserId: "u_other", type: "transfer", message: "x" });
  store.uploads.push({ id: "up_del", url: "/uploads/" + F1 });
  db.save();

  if (!fs.existsSync(UP)) fs.mkdirSync(UP, { recursive: true });
  fs.writeFileSync(path.join(UP, F1), Buffer.from("x"));
  fs.writeFileSync(path.join(UP, F2), Buffer.from("y"));

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // T1: non-admin blocked
  let r = await del("u_target", playerTok);
  assert.strictEqual(r.status, 403, "non-admin must be 403");
  console.log("PASS 1: non-admin cannot delete (403)");

  // T2: admin cascade delete
  r = await del("u_target", adminTok);
  assert.strictEqual(r.status, 200, "admin delete must be 200, got " + r.status);
  const body = await r.json();
  assert.ok(body.deleted.players >= 1, "player removed");
  assert.ok(body.deleted.messages >= 1, "message removed");
  assert.ok(body.deleted.registrations >= 1, "registration removed");
  assert.ok(body.deleted.transactions >= 1, "transaction removed");
  assert.ok(body.deleted.aiChats >= 1, "ai chat removed");
  assert.ok(body.deleted.reviews >= 1, "review removed");
  assert.ok(body.deleted.applications >= 1, "application removed");
  assert.ok(body.filesDeleted >= 2, "uploaded files physically deleted (got " + body.filesDeleted + ")");
  assert.ok(body.cloudDeleted >= 1, "remote Cloudinary video deleted (got " + body.cloudDeleted + ")");
  assert.ok(destroyedCloudIds.includes("manara/users/u_target/videos/abc123"), "Cloudinary destroy called with correct publicId");
  // data truly gone
  const s2 = db.get();
  assert.ok(!s2.users.find((u) => u.id === "u_target"), "user gone from store");
  assert.ok(!s2.players.find((p) => p.id === pTarget), "player profile gone");
  assert.ok(!s2.messages.find((m) => m.id === "m_del"), "message gone");
  assert.ok(!s2.clubs.find((c) => c.id === "c_other").shortlist.includes(pTarget), "shortlist reference removed");
  assert.ok(!s2.clubs.find((c) => c.id === "c_other").scoutNotes[pTarget], "scout-note reference removed");
  assert.ok(!fs.existsSync(path.join(UP, F1)), "player image file deleted from disk");
  assert.ok(!fs.existsSync(path.join(UP, F2)), "receipt file deleted from disk");
  console.log("PASS 2: admin deletes user + ALL owned data + uploaded files");

  // T3: another admin account cannot be deleted
  r = await del("u_admin2", adminTok);
  assert.strictEqual(r.status, 403, "deleting an admin must be 403");
  console.log("PASS 3: admin account cannot be deleted (403)");

  // T4: admin cannot delete self
  r = await del("u_admin", adminTok);
  assert.strictEqual(r.status, 403, "self-delete must be 403");
  console.log("PASS 4: admin cannot delete own account (403)");

  // T5: missing account
  r = await del("u_does_not_exist", adminTok);
  assert.strictEqual(r.status, 404, "missing account must be 404");
  console.log("PASS 5: deleting unknown account -> 404");

  // T6: audit log records who/when/what
  let lr = await fetch(base + "/api/admin/logs", { headers: authH(adminTok) });
  assert.strictEqual(lr.status, 200, "logs endpoint must be 200 for admin");
  const lbody = await lr.json();
  assert.ok(lbody.logs && lbody.logs.length >= 1, "at least one audit entry");
  const latest = lbody.logs[0];
  assert.strictEqual(latest.action, "DELETE_USER", "action recorded");
  assert.strictEqual(latest.adminId, "u_admin", "who recorded");
  assert.strictEqual(latest.targetUserId, "u_target", "what (target) recorded");
  assert.strictEqual(latest.targetName, "Target", "target name recorded");
  assert.ok(latest.deleted && latest.deleted.players >= 1, "deleted breakdown recorded");
  assert.strictEqual(latest.cloudDeleted, body.cloudDeleted, "cloudDeleted recorded in log");
  assert.ok(latest.timestamp, "when (timestamp) recorded");
  console.log("PASS 6: audit log records who/when/what for the deletion");

  // T7: audit log is admin-only
  lr = await fetch(base + "/api/admin/logs", { headers: authH(playerTok) });
  assert.strictEqual(lr.status, 403, "non-admin must not read logs (403)");
  console.log("PASS 7: audit log is admin-only (403)");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  console.log("\nADMIN ACCOUNT-DELETE VERIFIED OK");
}

main()
  .catch((e) => {
    try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
    console.error("TEST ERROR:", e);
    process.exit(1);
  })
  .finally(() => {
    // best-effort cleanup of test upload files
    [F1, F2].forEach((f) => { try { fs.unlinkSync(path.join(UP, f)); } catch (_) {} });
  });
