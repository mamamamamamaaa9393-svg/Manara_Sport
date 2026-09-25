// Shared test harness.
//
// Every test in this folder runs against a fully IN-MEMORY fake of ./db and a
// throwaway /uploads directory, so the real server/data/db.json and the real
// server/uploads are never read or written. The db module is replaced in
// require.cache BEFORE any route module is required, so every `require("../db")`
// inside the app picks up the fake.
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-manara-media-guard";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "manara-test-cloud";
process.env.CLOUDINARY_API_KEY = "key";
process.env.CLOUDINARY_API_SECRET = "secret";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "manara-test-"));
const TMP_UPLOADS = path.join(TMP_ROOT, "uploads");
fs.mkdirSync(TMP_UPLOADS, { recursive: true });

// --- fake db ---------------------------------------------------------------
const store = {
  users: [],
  players: [],
  clubs: [],
  registrations: [],
  transactions: [],
  ai_chats: [],
  messages: [],
  applications: [],
  uploads: [],
  knowledge: { faq: [], params: {} },
  revoked_tokens: []
};

let idSeq = {};
const fakeDb = {
  get: () => store,
  save: () => {},
  init: async () => {},
  nextId: (kind) => {
    idSeq[kind] = (idSeq[kind] || 0) + 1;
    return idSeq[kind];
  },
  publicPlayer: (p) => p,
  publicClub: (c) => c,
  sanitizePlayer: (p) => p,
  profileApproved: () => true,
  DATA_DIR: TMP_ROOT,
  DB_FILE: path.join(TMP_ROOT, "db.json")
};

function installFakeDb() {
  const dbPath = require.resolve(path.join(ROOT, "src", "db.js"));
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: fakeDb,
    children: [],
    paths: []
  };
  return store;
}

function resetStore() {
  Object.keys(store).forEach((k) => {
    if (Array.isArray(store[k])) store[k].length = 0;
  });
}

// --- per-process uploads sandbox -------------------------------------------
// `node --test` runs test FILES in parallel, each in its own process. If every
// file created and deleted fixtures in the real server/uploads directory, one
// file's after() cleanup would delete another file's fixtures mid-run and the
// suite would fail at random. So each process gets its own sandbox, and the
// real fs module is transparently redirected there for any path under
// server/uploads — mediaGuard resolves UPLOAD_DIR from __dirname at load time,
// so redirecting fs is the only way to keep production code free of test hooks.
const REAL_UPLOADS = path.join(ROOT, "uploads");
const SANDBOX_UPLOADS = path.join(TMP_ROOT, "sandbox-uploads");
fs.mkdirSync(SANDBOX_UPLOADS, { recursive: true });

const REAL_FS = require("fs");
const REAL_PATH = require("path");
const REAL_UPLOADS_RESOLVED = REAL_PATH.resolve(REAL_UPLOADS);

function redirect(p) {
  if (typeof p !== "string" || p.indexOf(REAL_UPLOADS_RESOLVED) !== 0) return p;
  const rel = REAL_PATH.relative(REAL_UPLOADS_RESOLVED, REAL_PATH.resolve(p));
  if (!rel || rel.startsWith("..") || REAL_PATH.isAbsolute(rel)) return p;
  return REAL_PATH.join(SANDBOX_UPLOADS, rel);
}

// Only path-taking functions are wrapped. Everything else (Stats, promises,
// constants) is copied by reference — wrapping a class in an arrow function
// would strip its .prototype and break `x instanceof fs.Stats` inside etag.
const PATH_FNS = [
  "accessSync", "appendFileSync", "chmodSync", "chownSync", "copyFileSync",
  "cpSync", "createReadStream", "createWriteStream", "existsSync", "lstatSync",
  "lutimesSync", "mkdirSync", "mkdtempSync", "openSync", "opendirSync",
  "readFileSync", "readdirSync", "readlinkSync", "realpathSync", "renameSync",
  "rmSync", "rmdirSync", "statSync", "statfsSync", "symlinkSync", "truncateSync",
  "unlinkSync", "utimesSync", "watch", "watchFile", "writeFileSync",
  "access", "copyFile", "cp", "lstat", "mkdir", "mkdtemp", "open", "readFile",
  "readdir", "readlink", "realpath", "rename", "rm", "rmdir", "stat", "symlink",
  "truncate", "unlink", "utimes", "writeFile"
];
const STREAM_FNS = new Set(["createReadStream", "createWriteStream"]);

const patchedFs = Object.create(REAL_FS);
for (const key of Object.keys(REAL_FS)) patchedFs[key] = REAL_FS[key];
for (const key of PATH_FNS) {
  const val = REAL_FS[key];
  if (typeof val !== "function") continue;
  patchedFs[key] = function (...args) {
    if (STREAM_FNS.has(key) && args[0] && typeof args[0] === "object" && !Buffer.isBuffer(args[0])) {
      if (args[0].path) args[0] = Object.assign({}, args[0], { path: redirect(args[0].path) });
    } else {
      args[0] = redirect(args[0]);
    }
    return val.apply(REAL_FS, args);
  };
}

// Node does not keep builtins in require.cache, so intercept the loader instead.
// From here on every `require("fs")` / `require("node:fs")` in this test process
// resolves to the redirecting wrapper.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "fs" || request === "node:fs") return patchedFs;
  return originalLoad.apply(this, arguments);
};

// --- fake uploads dir ------------------------------------------------------
// mediaGuard resolves UPLOAD_DIR to <repo>/uploads; the fs redirect above maps
// that to this process's sandbox.
function makeUploadFile(name, bytes) {
  const full = path.join(SANDBOX_UPLOADS, name);
  REAL_FS.mkdirSync(path.dirname(full), { recursive: true });
  REAL_FS.writeFileSync(full, Buffer.alloc(bytes || 64, 1));
  return "/uploads/" + name;
}

function removeUploadFile(name) {
  try { REAL_FS.unlinkSync(path.join(SANDBOX_UPLOADS, name)); } catch (e) {}
}

function cleanupUploads() {
  try {
    for (const f of REAL_FS.readdirSync(SANDBOX_UPLOADS)) {
      if (/^t_|test/i.test(f)) removeUploadFile(f);
    }
  } catch (e) {}
}

// --- fake user + JWT -------------------------------------------------------
const jwt = require(path.join(ROOT, "node_modules", "jsonwebtoken"));

function makeUser(overrides) {
  const now = Date.now();
  const u = Object.assign(
    {
      id: "u_test_player",
      role: "player",
      name: "Test Player",
      email: "t@test.local",
      trialStart: new Date(now).toISOString(),
      trialEnd: new Date(now + 7 * 864e5).toISOString()
    },
    overrides || {}
  );
  store.users.push(u);
  return u;
}

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, role: user.role, jti: "test-" + Math.random().toString(36).slice(2) },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

// --- tiny express app ------------------------------------------------------
function buildApp() {
  const express = require(path.join(ROOT, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: String((err && err.message) || err) });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function req(port, method, urlPath, body, token) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (payload) headers["Content-Length"] = payload.length;
    const r = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(out); } catch (e) {}
          resolve({ status: res.statusCode, body: json, raw: out });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

module.exports = {
  ROOT,
  TMP_ROOT,
  TMP_UPLOADS,
  SANDBOX_UPLOADS,
  sandboxFs: patchedFs,
  store,
  fakeDb,
  installFakeDb,
  resetStore,
  makeUploadFile,
  removeUploadFile,
  cleanupUploads,
  makeUser,
  tokenFor,
  buildApp,
  listen,
  req
};
