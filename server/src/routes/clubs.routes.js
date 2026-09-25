const router = require("express").Router();
const db = require("../db");
const helpers = require("../helpers");
const su = require("../searchUtils");
const { requireAuth } = require("../middleware/auth");
const requireActiveSub = require("../middleware/requireSub");

const mg = require("../mediaGuard");

// Same media hole as players.routes: `logo` / `documents` were copied verbatim
// from the request, so a club could point its proof documents at an arbitrary
// external URL and pull them out of the owner/admin gate in app.js.
// Returns { ok, value } or { ok:false, error }.
function guardClubMedia(picked) {
  const res = mg.checkProfileMedia(picked);
  if (!res.ok) return res;
  // drop the unsanitised copies so Object.assign cannot re-introduce them
  const clean = Object.assign({}, picked);
  ["documents", "logo"].forEach((k) => { delete clean[k]; });
  return { ok: true, value: Object.assign(clean, res.value) };
}


// Whitelist of fields a club may set (anti mass-assignment: verified,
// userId, id, createdAt are never client-writable)
const CLUB_FIELDS = [
  "name", "type", "sport", "country", "city", "founded", "league", "website",
  "contactName", "contactRole", "email", "phone", "whatsapp", "neededPosition",
  "logo", "documents", "description"
];

function pickClub(body) {
  const out = {};
  if (!body || typeof body !== "object") return out;
  CLUB_FIELDS.forEach((k) => { if (body[k] !== undefined) out[k] = body[k]; });
  return out;
}

// GET /api/clubs  — list + filter
router.get("/", (req, res) => {
  let list = db.get().clubs.filter((c) => db.profileApproved(c));
  const { sport, country, name, type, keyword } = req.query;
  // Same Arabic-aware normalized matching as the players endpoint.
  if (sport) {
    list = list.filter((c) => su.match(su.wrap([c.sport, c.keywords].filter(Boolean).join(" ")), su.expandQuery(String(sport))));
  }
  if (country) list = list.filter((c) => su.wrap(c.country).indexOf(su.norm(country)) !== -1);
  if (name) list = list.filter((c) => su.wrap(c.name).indexOf(su.norm(name)) !== -1);
  if (type) list = list.filter((c) => su.wrap(c.type).indexOf(su.norm(type)) !== -1);
  if (keyword && String(keyword).trim()) {
    const qTokens = su.expandQuery(String(keyword));
    list = list.filter((c) => su.match(su.wrap([
      c.name, c.type, c.sport, c.country, c.city, c.league,
      typeof c.keywords === "string" ? c.keywords : ""
    ].join(" ")), qTokens));
  }
  const total = list.length;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  list = list.slice(offset, offset + limit);
  return res.json({ clubs: list.map(db.publicClub), total, page, pages: Math.ceil(total / limit) });
});

// GET /api/clubs/:id — club profile (auth required, same policy as player
// profiles). The OWNER sees the full profile including contact info and
// their private shortlist. Any other signed-in account (a player scouting
// clubs, another club, ...) gets a masked copy: contact details and official
// documents are stripped so no direct external contact is possible. Accepts
// the internal id or the public random slug used in URLs.
router.get("/:id", requireAuth, (req, res) => {
  const store = db.get();
  const want = req.params.id;
  const c = store.clubs.find((x) => x.id === want || x.slug === want);
  if (!c || !db.profileApproved(c)) return res.status(404).json({ error: "Club not found" });
  const owner = !!c.userId && c.userId === req.user.id;
  const squad = store.players.filter(
    (p) => (p.currentClub || "").toLowerCase() === (c.name || "").toLowerCase()
  );
  const shortlist = owner
    ? (Array.isArray(c.shortlist) ? c.shortlist : [])
        .map((pid) => store.players.find((p) => p.id === pid))
        .filter(Boolean)
        .map(db.publicPlayer)
    : [];
  return res.json({
    club: owner ? c : db.publicClub(c),
    owner,
    squad: squad.map(db.publicPlayer),
    shortlist
  });
});

// POST /api/clubs  (club role)
router.post("/", requireAuth, requireActiveSub, (req, res) => {
  if (req.user.role !== "club") return res.status(403).json({ error: "Only club accounts can create club profiles" });
  const store = db.get();
  if (store.clubs.some((c) => c.userId === req.user.id)) {
    return res.status(409).json({ error: "You already have a club profile" });
  }
  const guard = guardClubMedia(pickClub(req.body));
  if (!guard.ok) return res.status(400).json({ error: guard.error });
  const c = Object.assign({ id: "c_" + db.nextId("club"), slug: helpers.randomSlug(12), userId: req.user.id, createdAt: new Date().toISOString() }, guard.value);
  store.clubs.push(c);
  db.save();
  return res.status(201).json({ club: c });
});

// PUT /api/clubs/:id  (owner)
router.put("/:id", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  const c = store.clubs.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Club not found" });
  if (c.userId !== req.user.id) return res.status(403).json({ error: "Not your club" });
  const guard = guardClubMedia(pickClub(req.body));
  if (!guard.ok) return res.status(400).json({ error: guard.error });
  Object.assign(c, guard.value, { id: c.id, userId: c.userId });
  db.save();
  return res.json({ club: c });
});

// DELETE /api/clubs/:id  (owner or admin)
router.delete("/:id", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  const idx = store.clubs.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Club not found" });
  const c = store.clubs[idx];
  if (c.userId !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "Not your club" });
  }
  store.clubs.splice(idx, 1);
  db.save();
  return res.json({ message: "تم حذف ملف النادي" });
});

module.exports = router;