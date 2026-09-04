/* Regression tests for "videos disappear after logout / re-login / next day":
   1) Videos added via the authenticated /api/cloudinary flow must be stored
      with a `url` field (not only `secureUrl`) so the profile grid can render
      them after a reload — otherwise they show on upload but vanish later.
   2) A pending upload referenced by a completed registration must be "claimed"
      (uploadedBy set to the owner) so the 24h orphan sweep can never delete a
      registered player's media, leaving dead /uploads/ URLs.
   db.json + uploads/ are backed up / cleaned so nothing persists. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".videos-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

// Mock Cloudinary BEFORE the app requires the route that uses it.
const cloudinary = require("cloudinary").v2;
const FAKE_SECURE = "https://res.cloudinary.com/demo/video/upload/v123/abc.mp4";
cloudinary.uploader.upload_stream = (params, cb) => {
  cb(null, { secure_url: FAKE_SECURE, resource_type: "video", duration: 12, width: 640, height: 360 });
};

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const app = require("../src/app");
const { sweepOrphanPendingUploads, claimUploads } = require("../src/uploadQuota");

let server, base, failures = 0;
function auth(role, id) { return "Bearer " + sign({ id: id || role + "_x", role }); }

async function main() {
  await db.init();
  const userId = "u_vidfix";
  const store = db.get();
  store.players = store.players || [];
  store.users = store.users || [];
  if (!store.users.find((u) => u.id === userId)) {
    // Active free trial so the subscription gate allows the video flow.
    store.users.push({ id: userId, role: "player", name: "VidFix", email: "vidfix@x.com", approved: true, subscriptionStatus: "trialing", trialStart: new Date().toISOString(), trialEnd: new Date(Date.now() + 5 * 86400000).toISOString() });
  }
  if (!store.players.find((p) => p.userId === userId)) {
    store.players.push({ id: "p_vidfix", userId, name: "VidFix", sport: "Football", currentClub: "X", approved: true, videos: [] });
  }

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // 1) Upload a video via /api/cloudinary (non player_video purpose skips the
  //    ffmpeg duration check that cannot run in CI).
  const fd = new FormData();
  fd.append("file", new Blob(["fakevideo"], { type: "video/mp4" }), "clip.mp4");
  fd.append("purpose", "profile_clip");
  let res = await fetch(base + "/api/cloudinary/", {
    method: "POST",
    headers: { Authorization: auth("player", userId) },
    body: fd
  });
  let body = await res.json();
  assert.strictEqual(res.status, 201, "upload should succeed, got " + JSON.stringify(body));
  assert.ok(body.url, "upload response must include url");
  assert.strictEqual(body.url, FAKE_SECURE, "url should be the cloud url");
  console.log("PASS 1: cloudinary upload stores+returns url");

  // 2) Owner fetch returns the stored video with a usable url
  res = await fetch(base + "/api/players/p_vidfix", {
    headers: { Authorization: auth("player", userId) }
  });
  body = await res.json();
  assert.ok(body.player.videos && body.player.videos.length, "player should have a video");
  assert.strictEqual(body.player.videos[0].url, FAKE_SECURE, "stored video must expose url");
  console.log("PASS 2: owner profile returns video url (renders after reload)");

  // 3) claimUploads protects a referenced pending upload from the sweep
  const fname = "claim_test_" + Date.now() + ".mp4";
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), "x");
  const url = "/uploads/" + fname;
  store.uploads.push({
    id: "up_claim", url, name: "c.mp4", size: 1, mimetype: "video/mp4",
    uploadedBy: "pending", createdAt: new Date(Date.now() - 2 * 86400000).toISOString()
  });
  claimUploads(store, [url], "someuser");
  assert.strictEqual(store.uploads.find((u) => u.id === "up_claim").uploadedBy, "someuser", "upload should be claimed");
  sweepOrphanPendingUploads();
  assert.ok(db.get().uploads.find((u) => u.id === "up_claim"), "claimed upload must survive sweep");
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, fname)), "claimed file must survive");
  console.log("PASS 3: claimed (registered) upload survives orphan sweep");

  // 4) When a video is promoted to Cloudinary, every reference (player.videos)
  //    must be rewritten from the local URL to the CDN URL — otherwise the local
  //    file is deleted and the profile keeps a dead link (the actual "videos
  //    vanish after re-login / next day" bug when Cloudinary is configured).
  const { rewriteReferencesToCloud } = require("../src/routes/uploads.routes");
  const localUrl = "/uploads/promo_test_xyz.mp4";
  const cloudUrl = "https://res.cloudinary.com/demo/video/upload/v1/manara/users/u1/videos/abc.mp4";
  const promoPlayer = { id: "p_promo", userId: "u_promo", name: "Promo", sport: "Football", videos: [{ url: localUrl, name: "clip.mp4" }] };
  store.players.push(promoPlayer);
  store.uploads.push({ id: "up_promo", url: localUrl, name: "clip.mp4", size: 1, mimetype: "video/mp4", uploadedBy: "pending", createdAt: new Date(Date.now() - 2 * 86400000).toISOString() });
  rewriteReferencesToCloud(store, localUrl, cloudUrl);
  // mirror promoteToCloudLater: the upload record's own url is also promoted
  const promoRec = store.uploads.find((u) => u.id === "up_promo");
  promoRec.url = cloudUrl;
  assert.strictEqual(promoPlayer.videos[0].url, cloudUrl, "player.videos url must be rewritten to CDN");
  // after rewrite the record (now CDN url) is referenced -> sweep keeps it
  sweepOrphanPendingUploads();
  assert.ok(db.get().uploads.find((u) => u.id === "up_promo"), "promoted record survives sweep once reference is rewritten");
  console.log("PASS 4: promotion rewrites references so videos survive (Cloudinary path)");

  // cleanup
  store.uploads = store.uploads.filter((u) => u.id !== "up_claim");
  store.players = store.players.filter((p) => p.id !== "p_vidfix");
  db.save();
  try { fs.unlinkSync(path.join(UPLOAD_DIR, fname)); } catch (e) {}

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
  console.log("\nVIDEOS PERSIST + RENDER VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
