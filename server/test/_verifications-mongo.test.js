/* Unit test: verifications survive the MongoDB flush/load round-trip
   (regression for the missing COLLECTIONS entry). Uses an in-memory fake
   Mongo driver persisted to a temp JSON file so a "restart" can be
   simulated without a real Atlas cluster.

   Run: node test/_verifications-mongo.test.js phase1   (write + flush)
        node test/_verifications-mongo.test.js phase2   (fresh load, assert)
*/
const path = require("path");
const fs = require("fs");

const STORE_FILE = path.join(process.env.TEMP || "/tmp", "opencode", "fake-mongo-store.json");
const PHASE = process.argv[2];

const FAKE = {
  load() { try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (e) { return {}; } },
  save(store) { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); }
};

class FakeCollection {
  constructor(name) { this.name = name; }
  _get() { const s = FAKE.load(); s[this.name] = s[this.name] || []; return s; }
  find() { return { toArray: async () => this._get()[this.name] }; }
  async findOne(q) { return this._get()[this.name].find((d) => d._id === (q && q._id)) || null; }
  async deleteMany() { const s = FAKE.load(); s[this.name] = []; FAKE.save(s); }
  async insertMany(docs) {
    const s = FAKE.load();
    s[this.name] = docs.map((d) => Object.assign({ _id: this.name + "_" + Math.random() }, d));
    FAKE.save(s);
  }
  async replaceOne(q, doc) {
    const s = FAKE.load();
    s[this.name] = s[this.name] || [];
    const i = s[this.name].findIndex((d) => d._id === (q && q._id));
    if (i >= 0) s[this.name][i] = doc; else s[this.name].push(doc);
    FAKE.save(s);
  }
}

class FakeClient {
  constructor() {}
  async connect() { return this; }
  db() { return { collection: (name) => new FakeCollection(String(name)) }; }
}

const mongoPath = require.resolve("mongodb");
require.cache[mongoPath] = {
  id: mongoPath,
  filename: mongoPath,
  loaded: true,
  exports: { MongoClient: FakeClient }
};
process.env.MONGODB_URI = "mongodb://fake/cluster";
process.env.MONGODB_DB = "manara";

const db = require("../src/db");

(async () => {
  await db.init();
  if (PHASE === "phase1") {
    const store = db.get();
    store.verifications = store.verifications || [];
    store.verifications.push({
      id: "v_restart_test",
      email: "restart@test.com",
      code: "654321",
      attempts: 0,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });
    db.save();
    await new Promise((r) => setTimeout(r, 800));
    const s = FAKE.load();
    const ok = (s.verifications || []).some((v) => v.id === "v_restart_test");
    console.log("phase1: flush wrote verifications collection:", ok ? "YES" : "NO");
    process.exit(ok ? 0 : 1);
  } else {
    const found = (db.get().verifications || []).find((v) => v.id === "v_restart_test");
    console.log("phase2: verification after restart:", found ? "FOUND (persisted)" : "MISSING (lost)");
    process.exit(found ? 0 : 1);
  }
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });