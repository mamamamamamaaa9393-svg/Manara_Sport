// FULL WIPE: remove every player/club account + everything related to them.
// Keeps ONLY admin users. Wipes: db records, local upload files, declaration
// vaults, Cloudinary assets (manara/* prefix), and attempts remote MongoDB
// cleanup when reachable.
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const DB_PATH = path.join(__dirname, "data", "db.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DECL_DIR = path.join(__dirname, "declarations");

const KEEP_ADMINS = true;
const CLEAR_COLLECTIONS = [
  "players", "clubs", "registrations", "messages", "applications",
  "reviews", "profile_views", "verifications", "ai_chats", "transactions"
];

(async () => {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));

  // ---- 1) Users: keep admins only
  const before = db.users.length;
  const keptAdmins = db.users.filter((u) => u.role === "admin");
  const keptIds = new Set(keptAdmins.map((a) => a.id));
  db.users = keptAdmins;
  console.log(`users: ${before} -> ${db.users.length} (kept: ${keptAdmins.map((a) => a.email).join(", ")})`);

  // ---- 2) Clear user-related collections entirely
  CLEAR_COLLECTIONS.forEach((k) => {
    console.log(`${k}: ${(db[k] || []).length} -> 0`);
    db[k] = [];
  });

  // ---- 3) Uploads: keep only records owned by an admin; collect doomed files
  const keptUploads = [];
  const doomedFiles = [];
  db.uploads.forEach((u) => {
    if (keptIds.has(u.uploadedBy)) keptUploads.push(u);
    else doomedFiles.push(u.url);
  });
  console.log(`uploads: ${db.uploads.length} -> ${keptUploads.length}`);
  db.uploads = keptUploads;
  fs.writeFileSync(DB_PATH, JSON.stringify(db));

  // ---- 4) Local files of deleted uploads (+ any file not referenced by kept data)
  const referenced = new Set(db.uploads.map((u) => u.url));
  let filesRemoved = 0;
  if (fs.existsSync(UPLOAD_DIR)) {
    fs.readdirSync(UPLOAD_DIR).forEach((name) => {
      const url = "/uploads/" + name;
      if (!referenced.has(url)) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); filesRemoved++; } catch (e) {}
      }
    });
  }
  console.log("local upload files removed:", filesRemoved);

  // ---- 5) Declaration vaults (encrypted player documents)
  if (fs.existsSync(DECL_DIR)) {
    fs.rmSync(DECL_DIR, { recursive: true, force: true });
    console.log("declarations vault: removed");
  }

  // ---- 6) Cloudinary assets uploaded by the platform (manara/* prefix)
  try {
    const res = await cloudinary.api.delete_resources_by_prefix("manara", { resource_type: "video", max_results: 100 });
    console.log("cloudinary videos deleted:", JSON.stringify(res.deleted || {}).slice(0, 120));
  } catch (e) { console.warn("cloudinary video cleanup warn:", e.message); }
  try {
    const res2 = await cloudinary.api.delete_resources_by_prefix("manara", { resource_type: "image", max_results: 100 });
    console.log("cloudinary images deleted:", Object.keys(res2.deleted || {}).length);
  } catch (e) { console.warn("cloudinary image cleanup warn:", e.message); }
  try {
    await cloudinary.api.delete_folder("manara/videos").catch(() => {});
    await cloudinary.api.delete_folder("manara/registrations").catch(() => {});
    await cloudinary.api.delete_folder("manara/users").catch(() => {});
    console.log("cloudinary folders cleaned");
  } catch (e) { /* non-fatal */ }

  // ---- 7) Remote MongoDB cleanup attempt (same URI the server uses)
  if (process.env.MONGODB_URI) {
    try {
      const mongo = require("mongodb");
      const client = new mongo.MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      const coll = client.db().collection;
      for (const k of CLEAR_COLLECTIONS) { await coll(k).deleteMany({}); }
      await coll("users").deleteMany({ role: { $ne: "admin" } });
      await coll("uploads").deleteMany({ uploadedBy: { $nin: [...keptIds] } });
      await client.close();
      console.log("mongodb remote: CLEANED ✅");
    } catch (e) {
      console.warn("\n⚠️ MongoDB unreachable (expected — Atlas IP whitelist pending).");
      console.warn("   Old copies remain in Atlas. When access is fixed, re-run this");
      console.warn("   script or wipe remotely — otherwise loadFromMongo may resurrect");
      console.warn("   old data over this clean state.\n");
    }
  }

  // ---- Final counts
  const check = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const summary = {};
  ["users", ...CLEAR_COLLECTIONS, "uploads"].forEach((k) => (summary[k] = (check[k] || []).length));
  console.log("\n=== FINAL STATE ===");
  console.log(JSON.stringify(summary, null, 1));
  console.log("seeded flag (must stay true):", check.seeded);
})();
