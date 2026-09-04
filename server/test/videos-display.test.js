/* Multi-scenario verification that videos DISPLAY correctly after the fix:
   S1 single Cloudinary-added video (secureUrl) renders for the owner
   S2 mixed LOCAL + Cloudinary videos both render
   S3 a promoted video's reference is rewritten to the CDN URL (no dead link)
      and the record survives the orphan sweep
   S4 a non-owner CLUB viewer also receives renderable videos
   S5 multiple videos are all returned
   db.json + uploads/ are backed up / cleaned so nothing persists. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".disp-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

// Mock Cloudinary so the authenticated add-video flow works offline.
const cloudinary = require("cloudinary").v2;
const FAKE = "https://res.cloudinary.com/demo/video/upload/v1/manara/users/u1/videos/abc.mp4";
cloudinary.uploader.upload_stream = (params, cb) =>
  cb(null, { secure_url: FAKE, resource_type: "video", duration: 12, width: 640, height: 360 });

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const app = require("../src/app");
const { sweepOrphanPendingUploads } = require("../src/uploadQuota");
const { rewriteReferencesToCloud } = require("../src/routes/uploads.routes");

let server, base, failures = 0;
const auth = (role, id) => "Bearer " + sign({ id: id || role + "_x", role });

async function main() {
  await db.init();
  const store = db.get();
  store.players = store.players || [];
  store.clubs = store.clubs || [];
  store.users = store.users || [];
  const ownerId = "u_disp", playerId = "p_disp", clubId = "u_disp_club";
  if (!store.users.find((u) => u.id === ownerId)) {
    // Active free trial so the subscription gate allows the video flow.
    store.users.push({ id: ownerId, role: "player", name: "Disp", email: "disp@x.com", approved: true, subscriptionStatus: "trialing", trialStart: new Date().toISOString(), trialEnd: new Date(Date.now() + 5 * 86400000).toISOString() });
  }
  if (!store.players.find((p) => p.userId === ownerId)) {
    store.players.push({ id: playerId, userId: ownerId, name: "Disp", sport: "Football", currentClub: "X", approved: true, videos: [] });
  }
  if (!store.clubs.find((c) => c.userId === clubId)) {
    store.clubs.push({ id: "c_disp", userId: clubId, name: "DispClub" });
  }

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // S1: single Cloudinary-added video renders for the owner
  let fd = new FormData();
  fd.append("file", new Blob(["v"], { type: "video/mp4" }), "a.mp4");
  fd.append("purpose", "profile_clip");
  let r = await fetch(base + "/api/cloudinary/", { method: "POST", headers: { Authorization: auth("player", ownerId) }, body: fd });
  let b = await r.json();
  assert.strictEqual(r.status, 201, "S1 upload status");
  assert.ok(b.url, "S1 upload returns url");
  r = await fetch(base + "/api/players/" + playerId, { headers: { Authorization: auth("player", ownerId) } });
  b = await r.json();
  assert.ok(b.player.videos.length >= 1 && (b.player.videos[0].url || b.player.videos[0].secureUrl), "S1 owner renders");
  console.log("PASS S1: single cloud video renders for owner");

  // S2: mixed LOCAL + Cloudinary videos both present/renderable
  const localUrl = "/uploads/disp_local.mp4";
  const pl = store.players.find((p) => p.id === playerId);
  pl.videos.push({ url: localUrl, name: "local.mp4", duration: 30 });
  fs.writeFileSync(path.join(UPLOAD_DIR, "disp_local.mp4"), "x");
  store.uploads.push({ id: "up_disp_local", url: localUrl, name: "local.mp4", size: 1, mimetype: "video/mp4", uploadedBy: ownerId, createdAt: new Date().toISOString() });
  r = await fetch(base + "/api/players/" + playerId, { headers: { Authorization: auth("player", ownerId) } });
  b = await r.json();
  assert.ok(b.player.videos.some((v) => v.url === localUrl), "S2 local present");
  assert.ok(b.player.videos.some((v) => (v.url || v.secureUrl) === FAKE), "S2 cloud present");
  console.log("PASS S2: mixed local + cloud videos both present for owner");

  // S3: promotion rewrites references (dead-link fix) and survives sweep
  const oldL = "/uploads/disp_promo.mp4", newC = "https://res.cloudinary.com/demo/video/upload/v1/manara/users/u1/videos/p.mp4";
  pl.videos.push({ url: oldL, name: "promo.mp4" });
  store.uploads.push({ id: "up_disp_promo", url: oldL, name: "promo.mp4", size: 1, mimetype: "video/mp4", uploadedBy: "pending", createdAt: new Date(Date.now() - 2 * 86400000).toISOString() });
  rewriteReferencesToCloud(store, oldL, newC);
  store.uploads.find((u) => u.id === "up_disp_promo").url = newC; // mirror promoteToCloudLater
  sweepOrphanPendingUploads();
  assert.ok(store.uploads.find((u) => u.id === "up_disp_promo"), "S3 record survives sweep");
  assert.strictEqual(pl.videos.find((v) => v.name === "promo.mp4").url, newC, "S3 reference rewritten");
  console.log("PASS S3: promoted video link rewritten (no dead link) + survives sweep");

  // S4: club (non-owner) viewer also sees renderable videos
  r = await fetch(base + "/api/players/" + playerId, { headers: { Authorization: auth("club", clubId) } });
  b = await r.json();
  assert.ok(b.player.videos && b.player.videos.length >= 1, "S4 club sees videos");
  assert.ok(b.player.videos.every((v) => v.url || v.secureUrl), "S4 club videos renderable");
  console.log("PASS S4: club/non-owner viewer sees renderable videos");

  // S5: multiple videos all returned
  r = await fetch(base + "/api/players/" + playerId, { headers: { Authorization: auth("player", ownerId) } });
  b = await r.json();
  assert.ok(b.player.videos.length >= 3, "S5 multiple videos (" + b.player.videos.length + ")");
  console.log("PASS S5: multiple videos (" + b.player.videos.length + ") all returned");

  // cleanup
  store.players = store.players.filter((p) => p.id !== playerId);
  store.clubs = store.clubs.filter((c) => c.userId !== clubId);
  store.uploads = store.uploads.filter((u) => !["up_disp_local", "up_disp_promo"].includes(u.id));
  db.save();
  try { fs.unlinkSync(path.join(UPLOAD_DIR, "disp_local.mp4")); } catch (e) {}
  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
  console.log("\nVIDEO DISPLAY SCENARIOS VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
