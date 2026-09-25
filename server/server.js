require("dotenv").config();

const app = require("./src/app");
const db = require("./src/db");
const { ensureSeeded, ensureAdmin } = require("./src/seed");
const sub = require("./src/subscription");
const { sweepOrphanPendingUploads } = require("./src/uploadQuota");
const { configureCloudinary } = require("./src/config/cloudinary");

const PORT = process.env.PORT || 5000;

async function start() {
  // Connect to MongoDB Atlas (falls back to the JSON file store offline),
  // then seed demo data only on a brand-new empty database.
  await db.init();

  // Configure Cloudinary video storage (backend-only, env-var driven)
  configureCloudinary();

  ensureSeeded();
  ensureAdmin();

  // Sweep pre-registration uploads that are older than 24h and no longer
  // referenced by any document (disk-fill defense for the unauthenticated
  // register-upload endpoint). Runs at boot + hourly.
  sweepOrphanPendingUploads();
  setInterval(sweepOrphanPendingUploads, 60 * 60 * 1000).unref();

  // Sweep trial/subscription transitions every 5 minutes (trial -> expired,
  // active -> past_due -> expired, milestone notifications). Lazy refresh also
  // happens on every /api/subscription/status call. Expiry-reminder emails are
  // sent once per period a few days before it ends.
  sub.refreshAll();
  setInterval(() => sub.refreshAll(), 5 * 60 * 1000);
  setInterval(() => { sub.sendExpiryReminders().catch(() => {}); }, 15 * 60 * 1000);

  // Node 18+ defaults requestTimeout to 5 min / headersTimeout to 1 min, which
  // would silently kill a large video upload long before the client's 40-min
  // xhr timeout. Raise the server-side frame so a single video (up to 230MB,
  // 1-10 min of footage over a slow connection) can finish in one request.
  // headersTimeout stays comfortably above keepAliveTimeout (5s) — it only
  // bounds the time to receive the request HEADERS, not the body.
  const http = require("http");
  const rawServer = http.createServer(app);
  rawServer.requestTimeout = 40 * 60 * 1000; // 40 min per request (large uploads)
  rawServer.headersTimeout = 65 * 1000;
  rawServer.keepAliveTimeout = 5000;
  rawServer.listen(PORT, () => {
    console.log("  Manara API + site running on http://localhost:" + PORT);
    console.log("  API health:  http://localhost:" + PORT + "/api/health");
    console.log("  Front-end:   http://localhost:" + PORT + "/");
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});