// ---------------------------------------------------------------------------
// Central guard for every client-supplied media reference (videos, documents,
// photos, logos).
//
// WHY THIS EXISTS
// A profile field like `player.videos` or `player.documents` is rendered by the
// browser straight from whatever URL the client stored. Before this module,
// `POST /api/players` and `PUT /api/players/:id` copied those fields verbatim
// (players.routes.js pickPlayer), so any authenticated user could store
//     { "videos": [{ "url": "https://attacker.example/x.mp4" }] }
// and completely bypass:
//   * validatePlayerVideo  (duration / resolution / anti-montage)
//   * isKnownVideoUrl      (the anti-forgery check used at sign-up)
// and additionally, by pointing a private `documents.*` entry at a URL that is
// no longer in the private-file set (app.js privateUploadUrls), push a proof
// document out of the owner/admin gate.
//
// RULE: nothing may be stored unless the server can prove it owns the bytes.
// Two accepted shapes only:
//   1) a /uploads/<name> file that exists on disk, or
//   2) a res.cloudinary.com delivery URL whose public_id EXACTLY matches a
//      known upload record (substring matching is rejected on purpose).
// ---------------------------------------------------------------------------
const path = require("path");
const fs = require("fs");
const db = require("./db");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

const MAX_VIDEOS = 6; // mirrors the sign-up UI cap (Sign_Up.html MAX_VIDEOS)

const VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|3gp|3g2|m4v)$/i;

// https://res.cloudinary.com/<cloud>/<resource_type>/upload/[/v<digits>/]<public_id>.<ext>
const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9]+)\/upload\/(?:v[0-9]+\/)?(.+)$/i;
const CLOUDINARY_VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|3gp|3g2|m4v|m4a|mp3)$/i;
const CLOUDINARY_IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const CLOUDINARY_RAW_EXT = /\.(pdf|docx?|xlsx?)$/i;

const ERR_VIDEOS = "بيانات الفيديو غير صالحة — ارفع الفيديوات من صفحة التسجيل فقط";
const ERR_DOCS = "ملف مرفق غير صالح — ارفعه من صفحة التسجيل فقط";

// --- low-level helpers ------------------------------------------------------

function isLocalUploadUrl(url) {
  return typeof url === "string" && url.startsWith("/uploads/") && url.indexOf("\n") === -1;
}

// Resolves a /uploads/<name> URL to a real path inside UPLOAD_DIR, or null.
// basename() + a containment re-check makes ../ traversal impossible.
function localFilePath(url) {
  if (!isLocalUploadUrl(url)) return null;
  const name = path.basename(url);
  if (!name || name === "." || name === "..") return null;
  const full = path.join(UPLOAD_DIR, name);
  if (path.dirname(path.resolve(full)) !== path.resolve(UPLOAD_DIR)) return null;
  return full;
}

function localFileExists(url) {
  const full = localFilePath(url);
  if (!full) return false;
  try {
    return fs.statSync(full).isFile();
  } catch (e) {
    return false;
  }
}

// Strict Cloudinary delivery-URL parser. Returns
// { cloud, resourceType, publicId, ext, folder } or null.
function parseCloudinaryUrl(url) {
  if (typeof url !== "string" || url.length > 1000) return null;
  const m = url.match(CLOUDINARY_URL);
  if (!m) return null;
  const full = m[3];
  // No query/fragment smuggling, no empty segments, no "..".
  if (full.indexOf("..") !== -1 || full.indexOf("?") !== -1 || full.indexOf("#") !== -1) return null;
  if (full.split("/").some((s) => s === "")) return null;
  const extM = full.match(/\.([a-z0-9]+)$/i);
  if (!extM) return null;
  const publicId = full.slice(0, -extM[0].length);
  if (!publicId) return null;
  const slash = publicId.lastIndexOf("/");
  return {
    cloud: m[1].toLowerCase(),
    resourceType: m[2].toLowerCase(),
    publicId,
    ext: extM[1].toLowerCase(),
    folder: slash === -1 ? "" : publicId.slice(0, slash + 1)
  };
}

function isOurCloud() {
  return String(process.env.CLOUDINARY_CLOUD_NAME || "").toLowerCase();
}

// A Cloudinary URL is only "ours" when the host segment is our own cloud name.
function isOwnCloudinaryUrl(url, resourceType, extTest) {
  const p = parseCloudinaryUrl(url);
  if (!p) return null;
  if (p.cloud !== isOurCloud()) return null;
  if (resourceType && p.resourceType !== resourceType) return null;
  if (extTest && !extTest.test("." + p.ext)) return null;
  return p;
}

// The upload record that owns this URL. `localUrl` is kept after a Cloudinary
// promotion so a client that still holds the pre-promotion /uploads/... value
// (the sign-up flow can POST /register between the upload and the background
// push) still validates instead of being rejected as a forgery.
function owningRecord(url) {
  // db.get() is null until db.init() resolves, and stays null if the db file is
  // unreadable. Every caller must then FAIL CLOSED (return null -> the URL is
  // rejected) instead of throwing a TypeError and turning a 400 into a 500.
  let store = null;
  try { store = db.get(); } catch (e) { return null; }
  if (!store) return null;
  const list = store.uploads || [];
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (u && (u.url === url || (u.localUrl && u.localUrl === url))) return u;
  }
  return null;
}

function recordMime(url) {
  const rec = owningRecord(url);
  return rec && typeof rec.mimetype === "string" ? rec.mimetype.toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Public predicates
// ---------------------------------------------------------------------------

// TRUE only for a URL the server can prove is a stored VIDEO.
function isKnownVideoUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  if (isLocalUploadUrl(trimmed)) {
    // A local file must look like a video by extension. A PDF/JPG can never be
    // smuggled in as a "video" this way.
    if (!VIDEO_EXT.test(trimmed)) return false;
    // The upload record is the source of truth. Checking the disk first would
    // reject a legitimate sign-up whose video was already promoted to
    // Cloudinary (the local file is then deleted but rec.localUrl is kept).
    const rec = owningRecord(trimmed);
    if (rec) {
      const mime = rec.mimetype ? String(rec.mimetype).toLowerCase() : "";
      return !mime || /^video\//.test(mime);
    }
    // No record -> fail closed. Every path that hands out a video URL creates
    // an upload record first (uploads.routes makeRecord, directUpload /confirm,
    // cloudinary.routes), and uploadQuota.collectReferencedUrls keeps records
    // that a profile still points at, so "no record" can only mean forged.
    return false;
  }

  if (/^https:\/\//i.test(trimmed)) {
    const p = isOwnCloudinaryUrl(trimmed, "video", CLOUDINARY_VIDEO_EXT);
    if (!p) return false;
    // The public_id must belong to a record WE stored. "It's on our CDN and the
    // id starts with manara/" is NOT enough — that would let any user point at
    // another user's video whose URL they happened to learn.
    const rec = owningRecord(trimmed);
    if (!rec) return false;
    return /^video\//.test(recordMime(trimmed) || "video/mp4");
  }

  return false; // http://, protocol-relative, data:, javascript: ... all rejected
}

// TRUE for any media file the server owns: local /uploads file, or one of our
// Cloudinary delivery URLs. Used for documents / photos / logos.
//
// Unlike videos, documents/photos/logos are never promoted to Cloudinary
// (only `isVideo(f) && purpose === "player_video"` is), so a Cloudinary URL in
// one of these fields has no legitimate origin and an owning record is
// required — otherwise any user could point a "proof document" at a media file
// that does belong to somebody else.
function isKnownMediaUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (isLocalUploadUrl(trimmed)) {
    // Fail closed without a record. Every upload path (register-upload,
    // finalizeFileRecord, directUpload /confirm) writes an upload record BEFORE
    // the URL reaches a client, so "no record" means forged — and it also keeps
    // this safe while db.get() is still null during startup.
    return Boolean(owningRecord(trimmed));
  }
  if (/^https:\/\//i.test(trimmed)) {
    const p = isOwnCloudinaryUrl(trimmed, null, null);
    if (!p) return false;
    if (!owningRecord(trimmed)) return false;
    return Boolean(
      isOwnCloudinaryUrl(trimmed, "video", CLOUDINARY_VIDEO_EXT) ||
        isOwnCloudinaryUrl(trimmed, "image", CLOUDINARY_IMAGE_EXT) ||
        isOwnCloudinaryUrl(trimmed, "raw", CLOUDINARY_RAW_EXT)
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shape validators — return { ok, value } / { ok:false, error }
// ---------------------------------------------------------------------------

// videos: array of { url, name?, size?, duration? }. Returns a rebuilt array
// with ONLY the whitelisted keys so a client cannot smuggle extra fields
// (publicId, provider, uploadedBy, ...) into a profile document.
function checkVideos(input) {
  if (input === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(input)) return { ok: false, error: ERR_VIDEOS };
  if (input.length > MAX_VIDEOS) return { ok: false, error: "الحد الأقصى " + MAX_VIDEOS + " فيديوهات" };
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    if (!v || typeof v !== "object") return { ok: false, error: ERR_VIDEOS };
    if (!isKnownVideoUrl(v.url)) return { ok: false, error: ERR_VIDEOS };
    const clean = { url: String(v.url).trim() };
    if (typeof v.name === "string") clean.name = v.name.slice(0, 200);
    if (Number.isFinite(+v.size)) clean.size = Math.max(0, Math.floor(+v.size));
    if (Number.isFinite(+v.duration)) clean.duration = Math.max(0, +v.duration);
    if (typeof v.poster === "string" && isKnownMediaUrl(v.poster)) clean.poster = v.poster;
    out.push(clean);
  }
  return { ok: true, value: out };
}

// keys that must never be copied, even though they match the charset — copying
// them into a plain object would pollute Object.prototype for the whole process
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// documents: the proof-document map ({ birth_cert, medical, official_letter,
// license, declaration }). Every value must be a file the server owns.
// `declaration` is also accepted as a bare string.
function checkDocuments(input) {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input === "string") {
    return isKnownMediaUrl(input)
      ? { ok: true, value: input.trim() }
      : { ok: false, error: ERR_DOCS };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: ERR_DOCS };
  }
  // null-prototype target: a stray __proto__ key can never reach Object.prototype
  const out = Object.create(null);
  const keys = Object.keys(input);
  if (keys.length > 12) return { ok: false, error: ERR_DOCS };
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const val = input[k];
    if (val === null || val === undefined || val === "") continue;
    if (FORBIDDEN_KEYS.has(k)) return { ok: false, error: ERR_DOCS };
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) return { ok: false, error: ERR_DOCS };
    if (!isKnownMediaUrl(val)) return { ok: false, error: ERR_DOCS };
    out[k] = String(val).trim();
  }
  return { ok: true, value: Object.assign({}, out) };
}

// photo / logo / declaration: a single media URL.
function checkSingleMediaUrl(input, err) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: input === "" ? "" : input };
  }
  return isKnownMediaUrl(input)
    ? { ok: true, value: String(input).trim() }
    : { ok: false, error: err || ERR_DOCS };
}

// Runs every media field of a player/club payload. Returns { ok:false, error }
// on the first violation, or { ok:true, value } where `value` holds ONLY the
// SANITISED media keys (videos / documents / photo / logo / declaration) —
// fields the caller did not supply are absent. Callers must merge this over a
// copy of the picked fields with the raw media keys deleted, so an unsanitised
// value can never be assigned (see guardPlayerMedia in players.routes.js).
function checkProfileMedia(fields) {
  const out = {};
  const v = checkVideos(fields.videos);
  if (!v.ok) return v;
  if (v.value !== undefined) out.videos = v.value;

  const d = checkDocuments(fields.documents);
  if (!d.ok) return d;
  if (d.value !== undefined) out.documents = d.value;

  const decl = checkSingleMediaUrl(fields.declaration, ERR_DOCS);
  if (!decl.ok) return decl;
  if (fields.declaration !== undefined) out.declaration = decl.value;

  const ph = checkSingleMediaUrl(fields.photo, ERR_DOCS);
  if (!ph.ok) return ph;
  if (fields.photo !== undefined) out.photo = ph.value;

  const lg = checkSingleMediaUrl(fields.logo, ERR_DOCS);
  if (!lg.ok) return lg;
  if (fields.logo !== undefined) out.logo = lg.value;

  return { ok: true, value: out };
}

module.exports = {
  MAX_VIDEOS,
  ERR_VIDEOS,
  ERR_DOCS,
  isLocalUploadUrl,
  localFilePath,
  localFileExists,
  parseCloudinaryUrl,
  isOwnCloudinaryUrl,
  owningRecord,
  isKnownVideoUrl,
  isKnownMediaUrl,
  checkVideos,
  checkDocuments,
  checkSingleMediaUrl,
  checkProfileMedia,
  CLOUDINARY_URL,
  VIDEO_EXT
};
