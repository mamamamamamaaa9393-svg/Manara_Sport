/* ==========================================================================
   Manara — Encrypted Declaration Vault.

   When the admin approves a player's registration, a copy of their scanned
   declaration (صورة الإقرار) is captured and stored HERE, encrypted at rest.

   Cryptography (military-grade defaults):
     - Key derivation : scrypt (N=32768, r=8, p=1) from the 3-word passphrase
     - Cipher         : AES-256-GCM (authenticated encryption)
     - Salt           : random 16 bytes per vault (stored alongside, not secret)
     - Per-file IV    : random 12 bytes, auth tag 16 bytes
   On-disk format of d_<id>.bin:  iv(12) || authTag(16) || ciphertext

   The vault is fully self-contained under server/declarations/:
     - vault.json  : salt + verification probe (decrypting the probe proves the
                     passphrase, without storing any plaintext hash)
     - index.json  : plain metadata list (player name / date / mime)
     - d_<id>.bin  : the encrypted declaration bytes
   Nothing here is served by the web server (no static mount for this folder).
   ========================================================================== */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ALGO = "aes-256-gcm";
const DECL_DIR = path.join(__dirname, "..", "declarations");
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const VAULT_FILE = path.join(DECL_DIR, "vault.json");
const INDEX_FILE = path.join(DECL_DIR, "index.json");
const PROBE = "MANARA::DECLARATIONS::VAULT::V1";
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

require("dotenv").config();

// The vault passphrase MUST come from the environment (same policy as
// JWT_SECRET). A hardcoded fallback shipped in source would defeat the
// at-rest encryption if a production deploy forgets to set NODE_ENV — so we
// REQUIRE VAULT_PASSPHRASE to be present in EVERY environment and never ship a
// default key. Presence of the variable (not its absence under a given
// NODE_ENV) is the only gate.
const rawVaultPass = process.env.VAULT_PASSPHRASE;
if (!rawVaultPass || !rawVaultPass.trim()) {
  throw new Error("VAULT_PASSPHRASE environment variable is required to start the declaration vault");
}
const PASS = rawVaultPass.split("::").map((s) => s.trim()).filter((s) => s.length);
if (!PASS.length) {
  throw new Error("VAULT_PASSPHRASE must contain at least one non-empty word separated by '::'");
}

function passphrase() {
  return PASS.join("::");
}

function ensureDir() {
  if (!fs.existsSync(DECL_DIR)) fs.mkdirSync(DECL_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

function writeJSON(file, obj) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function loadVault() {
  return readJSON(VAULT_FILE, null);
}

function loadIndex() {
  return readJSON(INDEX_FILE, { declarations: [], next: 1 });
}

function saveIndex(idx) {
  writeJSON(INDEX_FILE, idx);
}

function deriveKey(saltBuf, pass) {
  return crypto.scryptSync(pass, saltBuf, 32, SCRYPT);
}

// Create the vault on first use: generate the salt and store an encrypted
// probe. Verifying the passphrase later = successfully decrypting the probe.
function init() {
  ensureDir();
  if (loadVault()) return;
  const salt = crypto.randomBytes(16);
  const key = deriveKey(salt, passphrase());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(PROBE, "utf8")), cipher.final()]);
  writeJSON(VAULT_FILE, {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    cipher: enc.toString("base64")
  });
}

// Constant-work-ish check: GCM tag failure aborts; scrypt dominates the cost.
function verify(p1, p2, p3) {
  const v = loadVault();
  if (!v) return false;
  const pass = String(p1 || "") + "::" + String(p2 || "") + "::" + String(p3 || "");
  try {
    const key = deriveKey(Buffer.from(v.salt, "base64"), pass);
    const d = crypto.createDecipheriv(ALGO, key, Buffer.from(v.iv, "base64"));
    d.setAuthTag(Buffer.from(v.tag, "base64"));
    const dec = Buffer.concat([d.update(Buffer.from(v.cipher, "base64")), d.final()]);
    return dec.toString("utf8") === PROBE;
  } catch (e) {
    return false;
  }
}

// Resolve a declaration URL like "/uploads/abc.png" to a local file, but only
// inside the uploads directory (no path traversal, no remote fetch).
function resolveLocal(url) {
  if (!url || typeof url !== "string") return null;
  if (/^https?:\/\//i.test(url)) return null;
  let rel = url;
  if (url.startsWith("/uploads/")) rel = url.slice("/uploads/".length);
  else rel = url.replace(/^\/+/, "");
  const abs = path.resolve(UPLOAD_DIR, rel);
  if (abs !== UPLOAD_DIR && !abs.startsWith(UPLOAD_DIR + path.sep)) return null;
  try { if (fs.statSync(abs).isFile()) return abs; } catch (e) { return null; }
  return abs;
}

function mimeFromName(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)(\?|$)/);
  const ext = m ? m[1] : "";
  const map = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp"
  };
  return map[ext] || "application/octet-stream";
}

// Called from the approve handler. Returns the record, or null if there is no
// readable declaration file to capture.
function storeDeclaration(info) {
  init();
  const file = resolveLocal(info.declarationUrl);
  if (!file) return null;
  const v = loadVault();
  const key = deriveKey(Buffer.from(v.salt, "base64"), passphrase());
  const data = fs.readFileSync(file);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);

  const idx = loadIndex();
  const id = "d_" + (idx.next || 1);
  idx.next = (idx.next || 1) + 1;
  const rec = {
    id,
    playerId: info.playerId || null,
    playerName: info.playerName || "رياضي",
    approvedAt: info.approvedAt || new Date().toISOString(),
    mimetype: info.mimetype || mimeFromName(info.declarationUrl || ""),
    size: data.length
  };
  fs.writeFileSync(path.join(DECL_DIR, id + ".bin"), Buffer.concat([iv, cipher.getAuthTag(), enc]));
  // The plaintext original in uploads/ is now redundant and must be removed —
  // otherwise the at-rest encryption is defeated by the still-readable copy.
  try { fs.unlinkSync(file); } catch (e) {
    console.warn("[declarations] could not delete source file " + file + ": " + e.message);
  }
  idx.declarations.push(rec);
  saveIndex(idx);
  return rec;
}

// Decrypt and return one stored declaration (only callable after the
// passphrase gate has been passed at the route layer).
function readDeclaration(id) {
  const idx = loadIndex();
  const rec = (idx.declarations || []).find((r) => r.id === id);
  if (!rec) return null;
  const v = loadVault();
  if (!v) return null;
  let buf;
  try { buf = fs.readFileSync(path.join(DECL_DIR, id + ".bin")); } catch (e) { return null; }
  if (buf.length < 28) return null;
  try {
    const key = deriveKey(Buffer.from(v.salt, "base64"), passphrase());
    const d = crypto.createDecipheriv(ALGO, key, buf.slice(0, 12));
    d.setAuthTag(buf.slice(12, 28));
    const dec = Buffer.concat([d.update(buf.slice(28)), d.final()]);
    return { data: dec, mimetype: rec.mimetype, rec };
  } catch (e) {
    return null;
  }
}

function list() {
  return (loadIndex().declarations || []).slice()
    .sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt));
}

function status() {
  return { configured: !!loadVault(), count: (loadIndex().declarations || []).length };
}

// Permanently purge every stored declaration for a player (used when an admin
// deletes the player's account — "everything belonging to that account").
function removeDeclaration(playerId) {
  if (!playerId) return 0;
  const idx = loadIndex();
  const list = idx.declarations || [];
  let n = 0;
  list.filter((r) => r.playerId === playerId).forEach((r) => {
    try { fs.unlinkSync(path.join(DECL_DIR, r.id + ".bin")); n++; } catch (e) { /* ignore */ }
  });
  idx.declarations = list.filter((r) => r.playerId !== playerId);
  saveIndex(idx);
  return n;
}

module.exports = { init, verify, storeDeclaration, readDeclaration, list, status, removeDeclaration, mimeFromName };