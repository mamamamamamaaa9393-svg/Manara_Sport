/* ==========================================================================
   Manara data store.
   Primary: MongoDB Atlas (MONGODB_URI from .env). If unreachable it falls
   back to the local JSON file (data/db.json) so the app still runs offline.
   The whole store is mirrored in memory — the route layer keeps working
   unchanged (db.get() / db.nextId() / db.save()).
   ========================================================================== */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const helpers = require("./helpers");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DB_NAME = process.env.MONGODB_DB || "manara";
const COLLECTIONS = ["users", "players", "clubs", "messages", "applications", "uploads", "registrations", "ai_chats", "transactions", "webhooks", "reviews", "profile_views", "verifications", "inquiries", "faq", "platform_params"];

let MongoClient = null;
try { MongoClient = require("mongodb").MongoClient; } catch (e) { MongoClient = null; }

let db = null;

function emptyDb() {
  return {
    seeded: false,
    counters: {
      user: 0,
      player: 0,
      club: 0,
      message: 0,
      application: 0,
      upload: 0,
      registration: 0,
      transaction: 0,
      ai_chat: 0,
      review: 0,
      profile_view: 0,
      inquiry: 0,
      faq: 0,
      platform_param: 0
    },
    users: [],
    players: [],
    clubs: [],
    messages: [],
    applications: [],
    uploads: [],
    registrations: [],
    ai_chats: [],
    transactions: [],
    webhooks: [],
    reviews: [],
    profile_views: [],
    verifications: [],
    inquiries: [],
    faq: [],
    platform_params: []
  };
}

// Subscription fields for the SaaS paywall (gamer 39 EGP / club 299 EGP) +
// the free trial. Admin-approved platform accounts map to a
// subscription user type: player accounts are "gamer", club accounts are
// "club".
function normalizeUsers() {
  if (!Array.isArray(db.users)) db.users = [];
  db.users.forEach((u) => {
    if (!u.userType) u.userType = u.role === "club" ? "club" : (u.role === "admin" ? "club" : "gamer");
    if (!u.subscriptionStatus) u.subscriptionStatus = "inactive";
    if (u.subscriptionExpiresAt == null) u.subscriptionExpiresAt = null;
    // trial fields
    if (u.trialStart == null) u.trialStart = null;
    if (u.trialEnd == null) u.trialEnd = null;
    if (!u.trialNotified) u.trialNotified = {};
    if (!u.expiryNotified) u.expiryNotified = {};
    if (!u.pendingNotifications) u.pendingNotifications = [];
    // subscription period / provider fields
    if (u.periodStart == null) u.periodStart = null;
    if (u.nextBillingDate == null) u.nextBillingDate = null;
    if (u.cancelAtPeriodEnd == null) u.cancelAtPeriodEnd = false;
    if (!u.plan) u.plan = u.userType || (u.role === "club" ? "club" : "gamer");
    if (u.price == null) u.price = null;
    if (!u.currency) u.currency = "EGP";
    if (u.providerId == null) u.providerId = null;
    if (u.providerCustomerId == null) u.providerCustomerId = null;
    if (u.renewalAttempts == null) u.renewalAttempts = 0;
    if (u.paymentFailureAt == null) u.paymentFailureAt = null;
  });
}

// Whether a user's subscription is currently active (paid + not expired).
function isSubActive(user) {
  if (!user) return false;
  if (user.subscriptionStatus !== "active") return false;
  if (!user.subscriptionExpiresAt) return false;
  return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
}

// Backfill random public slugs for any player/club created before the
// slugs feature existed (seed data, older registrations).
function ensureSlugs() {
  let changed = false;
  (db.players || []).forEach((p) => {
    if (!p.slug) { p.slug = helpers.randomSlug(12); changed = true; }
  });
  (db.clubs || []).forEach((c) => {
    if (!c.slug) { c.slug = helpers.randomSlug(12); changed = true; }
  });
  return changed;
}

/* --------------------------------------------------------------------------
   File-based fallback (unchanged behaviour)
   -------------------------------------------------------------------------- */
function load() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      // Normalize: older db.json files miss newer collections/counters.
      COLLECTIONS.forEach((name) => { if (!Array.isArray(db[name])) db[name] = []; });
      db.counters = Object.assign(emptyDb().counters, db.counters || {});
      normalizeUsers();
      if (ensureSlugs()) save();
      return db;
    } catch (e) {
      // DURABILITY: a truncated/corrupt db.json must NEVER be silently wiped
      // by saving an empty store over it. Quarantine the bad file so the
      // data can be recovered manually, then start fresh.
      const quarantine = DB_FILE + ".corrupt-" + Date.now() + ".bak";
      try { fs.renameSync(DB_FILE, quarantine); } catch (e2) {}
      console.error("[db] db.json was corrupt — quarantined as " + quarantine + " (" + e.message + ")");
      db = emptyDb();
    }
  } else {
    db = emptyDb();
  }
  save();
  return db;
}

// DURABILITY: write to a temp file then atomically rename over the target.
// A crash mid-write can truncate the temp copy but never the live database.
function save() {
  if (!db) return;
  if (db._mongo) {
    db._dirty = true;
    scheduleFlush();
    return;
  }
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function nextId(collection) {
  db.counters[collection] = (db.counters[collection] || 0) + 1;
  return db.counters[collection];
}

function reset() {
  const client = db && db._mongo;
  db = emptyDb();
  snapshots = {};
  if (client) { db._mongo = client; db._dirty = true; }
  save();
}

/* --------------------------------------------------------------------------
   MongoDB Atlas
   -------------------------------------------------------------------------- */
function stripId(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const copy = Object.assign({}, doc);
  delete copy._id;
  return copy;
}

async function loadFromMongo() {
  const dbc = db._mongo.db(DB_NAME);
  let total = 0;
  for (const name of COLLECTIONS) {
    const arr = await dbc.collection(name).find({}).toArray();
    db[name] = arr.map(stripId);
    total += arr.length;
  }
  const meta = await dbc.collection("meta").findOne({ _id: "main" });
  db.counters = (meta && meta.counters) || emptyDb().counters;
  db.seeded = !!(meta && meta.seeded);
  normalizeUsers();
  rebuildSnapshots();
  return total > 0;
}

// First boot against an empty Atlas cluster: carry over the existing local
// data (data/db.json) so nothing is lost, instead of seeding from scratch.
function migrateFromFileIfPresent() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const file = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!file || typeof file !== "object") return;
    COLLECTIONS.forEach((name) => {
      db[name] = Array.isArray(file[name]) ? file[name].map(stripId) : (emptyDb()[name] || []);
    });
    db.counters = file.counters || emptyDb().counters;
    db.seeded = !!file.seeded;
    normalizeUsers();
    db._dirty = true;
    flush();
    console.log("  Imported existing data/db.json into MongoDB");
  } catch (e) {
    /* nothing to import */
  }
}

// Snapshot of the last-flushed state per collection:
// Map(String(doc.id) -> { origId, json }). The diff between a snapshot and
// the live array drives document-level persistence (no wipe/reinsert).
let snapshots = {};

function buildSnapshot(arr) {
  const m = new Map();
  for (const doc of arr || []) {
    const n = stripId(doc);
    if (!n || n.id === undefined || n.id === null) continue;
    m.set(String(n.id), { origId: n.id, json: JSON.stringify(n) });
  }
  return m;
}

function rebuildSnapshots() {
  snapshots = {};
  for (const name of COLLECTIONS) snapshots[name] = buildSnapshot(db[name]);
}

let flushing = false;
let reflushQueued = false; // writes that arrived DURING an in-flight flush
let retryTimer = null;
let activeFlush = null;    // promise of the currently-running flush
function flush() {
  if (!db || !db._mongo) return Promise.resolve();
  if (flushing) { reflushQueued = true; return activeFlush || Promise.resolve(); }
  if (!db._dirty) return Promise.resolve();
  flushing = true;
  activeFlush = (async () => {
  try {
    const dbc = db._mongo.db(DB_NAME);
    for (const name of COLLECTIONS) {
      const col = dbc.collection(name);
      const arr = db[name] || [];
      const snap = snapshots[name] || new Map();

      // Current in-memory state keyed by document id
      const current = new Map();
      for (const doc of arr) {
        const n = stripId(doc);
        if (!n || n.id === undefined || n.id === null) continue; // never persisted blindly
        current.set(String(n.id), { doc: n, json: JSON.stringify(n) });
      }

      const ops = [];
      // delete -> deleteOne: documents removed from memory since last flush
      for (const [key, entry] of snap) {
        if (!current.has(key)) ops.push({ deleteOne: { filter: { id: entry.origId } } });
      }
      // create/update -> updateOne + $set with upsert:true
      // (upsert makes creation idempotent: no duplicate records even after crashes)
      for (const cur of current.values()) {
        const prev = snap.get(String(cur.doc.id));
        if (!prev || prev.json !== cur.json) {
          ops.push({
            updateOne: {
              filter: { id: cur.doc.id },
              update: { $set: cur.doc },
              upsert: true,
            },
          });
        }
      }

      if (ops.length) await col.bulkWrite(ops, { ordered: false });
      snapshots[name] = buildSnapshot(arr);
    }
    await dbc.collection("meta").replaceOne(
      { _id: "main" },
      { _id: "main", counters: db.counters, seeded: db.seeded },
      { upsert: true }
    );
    db._dirty = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  } catch (e) {
    console.error("  MongoDB incremental flush failed:", e.message);
    // Retry once shortly so a transient network blip cannot lose data.
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; flush(); }, 10000);
  } finally {
    flushing = false;
    activeFlush = null;
    // A save() during the flush set _dirty again — run another pass so those
    // writes are never left unpersisted.
    if (reflushQueued) {
      reflushQueued = false;
      flush();
    }
  }
  })();
  return activeFlush;
}

let debounceTimer = null;
function scheduleFlush() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flush();
  }, 300);
}

async function init() {
  if (!MongoClient) { load(); return; }
  const uri = process.env.MONGODB_URI;
  if (!uri) { load(); return; }
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = emptyDb();
    db._mongo = client;
    db._dirty = false;
    const hasData = await loadFromMongo();
    if (!hasData) migrateFromFileIfPresent();
    console.log("  MongoDB Atlas connected — database: " + DB_NAME);
    // Persistence is event-driven (save() -> debounced incremental flush).
    // No periodic full sync. A failed flush retries itself; shutdown flushes.
    const gracefulFlush = async () => {
      try {
        reflushQueued = false;
        db._dirty = true;      // force one final pass even if flags look clean
        await flush();         // runs now, or returns the in-flight promise
        if (activeFlush) await activeFlush; // chained rerun of queued writes
      } catch (e) {}
      process.exit(0);
    };
    process.on("SIGINT", gracefulFlush);
    process.on("SIGTERM", gracefulFlush);
    return;
  } catch (e) {
    console.error("  MongoDB connection failed (" + e.message + ") — falling back to JSON file store");
    db = null;
    load();
  }
}

/* --------------------------------------------------------------------------
   Serialization helpers (same API as before)
   -------------------------------------------------------------------------- */
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, role: u.role, email: u.email, name: u.name };
}

function sanitizePlayer(p) {
  if (!p) return null;
  const copy = Object.assign({}, p);
  delete copy._password;
  return copy;
}

// Public copy of a player for lists/browsing — strips private contact data
// (phone, email, whatsapp, instagram) and official documents.
function publicPlayer(p) {
  if (!p) return null;
  const copy = Object.assign({}, p);
  delete copy._password;
  delete copy.phone;
  delete copy.email;
  delete copy.whatsapp;
  delete copy.instagram;
  delete copy.documents;
  delete copy.declaration;
  return copy;
}

function maskPhone(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (s.length <= 4) return "••••";
  return s.slice(0, 3) + "***" + s.slice(-2);
}

function maskEmail(v) {
  if (!v) return "";
  const s = String(v).trim();
  const at = s.indexOf("@");
  if (at <= 1) return "***" + s.slice(Math.max(0, at));
  return s.slice(0, 1) + "***" + s.slice(at);
}

// Semi-private copy for scouting: profile details are visible but contact
// info is masked (no external contact possible) and official documents +
// declaration are hidden for non-owners.
function maskPlayer(p) {
  if (!p) return null;
  const copy = Object.assign({}, p);
  delete copy._password;
  copy.phone = copy.phone ? maskPhone(copy.phone) : "";
  copy.whatsapp = copy.whatsapp ? maskPhone(copy.whatsapp) : "";
  copy.email = copy.email ? maskEmail(copy.email) : "";
  copy.instagram = copy.instagram ? "@" + String(copy.instagram).replace(/^@/, "").slice(0, 1) + "***" : "";
  delete copy.documents;
  delete copy.declaration;
  return copy;
}

// Public copy of a club for lists/browsing — strips private contact data
// (phone, email, whatsapp, contactName) and official documents so the public
// club board never leaks a club's direct contact details.
function publicClub(c) {
  if (!c) return null;
  const copy = Object.assign({}, c);
  delete copy._password;
  delete copy.phone;
  delete copy.email;
  delete copy.whatsapp;
  delete copy.contactName;
  delete copy.contactRole;
  delete copy.documents;
  // The declaration (scanned ID/declaration image) is sensitive — never
  // expose it on the public club board or in a third-party viewer context.
  delete copy.declaration;
  return copy;
}

// Whether a profile's account has passed admin review. Profiles with no owner
// (seeded demo athletes) and legacy accounts (no `approved` field) are visible.
// Accounts awaiting approval or rejected (approved === false) stay hidden.
function profileApproved(p) {
  if (!p || !p.userId) return true;
  const u = db.users.find((x) => x.id === p.userId);
  if (!u) return true;
  return u.approved !== false;
}

module.exports = {
  init,
  load,
  save,
  nextId,
  reset,
  get: () => db,
  publicUser,
  sanitizePlayer,
  publicPlayer,
  maskPlayer,
  publicClub,
  profileApproved,
  normalizeUsers,
  isSubActive,
  DATA_DIR,
  DB_FILE
};