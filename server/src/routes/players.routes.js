const router = require("express").Router();
const db = require("../db");
const helpers = require("../helpers");
const su = require("../searchUtils");
const sub = require("../subscription");
const { requireAuth } = require("../middleware/auth");
const requireActiveSub = require("../middleware/requireSub");

const mg = require("../mediaGuard");

// pickPlayer copies `videos` / `documents` / `photo` / `declaration` straight
// from the request body, which let any authenticated player store an arbitrary
// external URL in a PUBLIC profile field — bypassing validatePlayerVideo,
// bypassing the sign-up anti-forgery check (auth.routes isKnownVideoUrl), and
// for documents, escaping the owner/admin gate in app.js privateUploadUrls().
// Every media field must therefore be re-validated here against mediaGuard and
// replaced by its sanitised form before it reaches the stored document.
// Returns { ok, value } or { ok:false, error }.
function guardPlayerMedia(picked) {
  const res = mg.checkProfileMedia(picked);
  if (!res.ok) return res;
  // drop the unsanitised copies so Object.assign cannot re-introduce them
  const clean = Object.assign({}, picked);
  ["videos", "documents", "photo", "declaration"].forEach((k) => { delete clean[k]; });
  return { ok: true, value: Object.assign(clean, res.value) };
}

// Whitelist of fields a player may set on its own profile (anti mass-assignment:
// verified / rating / reviews / userId / id / createdAt are never client-writable)
const PLAYER_FIELDS = [
  "name", "dob", "age", "sport", "position", "foot", "hand", "height", "weight",
  "level", "country", "currentClub", "bio", "stats", "phone", "whatsapp",
  "email", "instagram", "available", "photo", "videos", "documents",
  "declaration", "files", "keywords", "postedDays"
];

function pickPlayer(body) {
  const out = {};
  if (!body || typeof body !== "object") return out;
  PLAYER_FIELDS.forEach((k) => { if (body[k] !== undefined) out[k] = body[k]; });
  return out;
}

// GET /api/players  — list + filter + sort + paginate
//   sport=Football&keyword=striker&position=...&country=...&level=...&available=1
//   sort=recent|name|rating&page=1&limit=12
router.get("/", (req, res) => {
  let list = db.get().players.filter((p) => db.profileApproved(p));

  const { sport, keyword, position, country, level, available } = req.query;

  // All text filters share the same Arabic-aware matching; sport/position go
  // through full synonym expansion so "كرة السلة" matches "Basketball" etc.
  if (sport) {
    const qSport = su.expandQuery(String(sport));
    list = list.filter((p) => su.match(su.wrap([p.sport, p.keywords].filter(Boolean).join(" ")), qSport));
  }
  if (position) {
    const qPos = su.expandQuery(String(position));
    list = list.filter((p) => su.match(su.wrap([p.position, p.keywords].filter(Boolean).join(" ")), qPos));
  }
  if (country) list = list.filter((p) => su.wrap(p.country).indexOf(su.norm(country)) !== -1);
  if (level) {
    const lvlSet = new Set([su.norm(level)]);
    // accept bilingual level synonyms (محترف == pro == professional)
    su.expandQuery(level).forEach((set) => set.forEach((t) => { if (t.length > 3) lvlSet.add(t); }));
    list = list.filter((p) => {
      const lv = su.norm(p.level);
      if (lvlSet.has(lv)) return true;
      return [...lvlSet].some((t) => t.length > 3 && su.wrap(lv).indexOf(" " + t + " ") !== -1);
    });
  }

  // Keyword search: token-based AND with Arabic normalization and
  // Arabic<->English synonym expansion. Searches name, position, club,
  // sport, country, level, baked keywords AND the player's bio/stats.
  let scored = null;
  if (keyword && String(keyword).trim()) {
    const qTokens = su.expandQuery(String(keyword));
    scored = [];
    list.forEach((p) => {
      const hay = su.wrap([
        p.name, p.position, p.currentClub, p.sport, p.country, p.level,
        typeof p.keywords === "string" ? p.keywords : "",
        p.bio || "", typeof p.stats === "string" ? p.stats : ""
      ].join(" "));
      if (!su.match(hay, qTokens)) return;
      const s = su.score(qTokens, {
        name: p.name,
        position: p.position,
        keywords: [p.keywords, p.bio].filter(Boolean).join(" "),
        rest: [p.currentClub, p.sport, p.country, p.level].join(" ")
      });
      scored.push({ p, s });
    });
    list = scored.map((x) => x.p);
  }

  if (available !== undefined) {
    const wantAvail = available === "1" || available === "true";
    list = list.filter((p) => (p.available === true) === wantAvail);
  }

  const sort = req.query.sort || (scored ? "relevant" : "recent");
  // Recency is always derived from the server-side createdAt timestamp —
  // never from a client-writable stored value.
  const daysPosted = (p) => {
    const created = p.createdAt ? new Date(p.createdAt).getTime() : 0;
    return created && isFinite(created)
      ? Math.max(0, Math.floor((Date.now() - created) / 86400000))
      : (Number(p.postedDays) || 0);
  };
  if (sort === "relevant" && scored) {
    // Relevance first (name > position > keywords/bio > rest), then freshest.
    scored.sort((a, b) => b.s - a.s || daysPosted(a.p) - daysPosted(b.p));
    list = scored.map((x) => x.p);
  } else if (sort === "name") list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sort === "rating") {
    list.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
      (Number(b.reviews) || 0) - (Number(a.reviews) || 0));
  }
  else if (sort !== "relevant") list.sort((a, b) => daysPosted(a) - daysPosted(b));

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const start = (page - 1) * limit;

  return res.json({
    players: list.slice(start, start + limit).map(db.publicPlayer),
    total: list.length,
    page,
    limit
  });
});

// GET /api/players/:id (auth required). The OWNER sees the full profile
// (contact + documents). Any other signed-in account (e.g. a club scouting)
// sees a masked copy: contact info is partially hidden and documents are
// removed, so no external contact is possible. Accepts the internal id or
// the public random slug used in URLs.
router.get("/:id", requireAuth, (req, res) => {
  const store = db.get();
  const want = req.params.id;
  const p = store.players.find((x) => x.id === want || x.slug === want);
  if (!p || !db.profileApproved(p)) return res.status(404).json({ error: "Player not found" });
  const owner = p.userId === req.user.id;

  // Paywall: viewing your OWN profile requires an active subscription or the
  // free trial. Public discovery (a club scouting a player) stays open — only
  // the owner's own locked-out account is blocked (server-side, never trusted
  // from the client).
  if (owner) {
    const me = store.users.find((x) => x.id === req.user.id);
    if (me) {
      const changed = sub.refresh(me);
      if (changed) db.save();
      if (!sub.hasAccess(me)) {
        return res.status(402).json({
          error: "انتهت تجربتك المجانية — يرجى الاشتراك لعرض ملفك الشخصي.",
          code: "SUBSCRIPTION_REQUIRED",
          requiresPayment: true
        });
      }
    }
  }

  // "Who viewed my profile": every non-owner view is logged (deduped per
  // viewer). Admins browsing for review are not counted as scouts.
  if (!owner && req.user.role !== "admin") {
    recordView(store, p, req.user);
  }

  const player = owner ? db.sanitizePlayer(p) : db.maskPlayer(p);

  // Clubs browsing a player may view the player's MEDICAL REPORT only — a
  // regulated, role-specific document. No other proof document (birth
  // certificate / declaration) is exposed to clubs. Other viewers get none.
  if (!owner && req.user.role === "club" && p.documents && p.documents.medical) {
    player.documents = { medical: p.documents.medical };
  }
  const club = store.clubs.find((c) => (c.name || "").toLowerCase() === (p.currentClub || "").toLowerCase());
  const reviews = store.reviews
    .filter((r) => r.playerId === p.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const myReview = req.user.role === "club" ? reviews.find((r) => r.clubUserId === req.user.id) || null : null;
  // Shortlist + private scout note state for the browsing club.
  let shortlisted = false;
  let myScoutNote = null;
  if (req.user.role === "club") {
    const club = store.clubs.find((c) => c.userId === req.user.id);
    if (club) {
      shortlisted = Array.isArray(club.shortlist) && club.shortlist.indexOf(p.id) !== -1;
      myScoutNote = (club.scoutNotes && club.scoutNotes[p.id]) || null;
    }
  }
  // Only the owner can see who viewed their profile.
  const views = owner ? viewsFor(store, p.id) : [];
  // The matched currentClub is a THIRD-PARTY registered club (not the viewer),
  // so its contact details + official documents must never be exposed. Return
  // the public (stripped) copy for everyone — the viewer does not own it.
  const clubOut = club ? db.publicClub(club) : null;
  return res.json({ player, club: clubOut, owner, reviews, myReview, shortlisted, myScoutNote, views });
});

// --- Profile-view tracking ("من شاهد بروفايلك") -----------------------------

// One entry per viewer per player, so re-visits bump the timestamp instead
// of growing the collection. Keeps a viewer's identity: role + club name.
function recordView(store, player, viewer) {
  const viewerUser = store.users.find((u) => u.id === viewer.id);
  const name = (viewerUser && viewerUser.name) || viewer.id || "مستخدم";
  const club = viewer.role === "club" ? store.clubs.find((c) => c.userId === viewer.id) : null;
  const existing = store.profile_views.find(
    (v) => v.playerId === player.id && v.viewerUserId === viewer.id
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.at = now;
    existing.count = (existing.count || 1) + 1;
  } else {
    store.profile_views.push({
      id: "pv_" + db.nextId("profile_view"),
      playerId: player.id,
      viewerUserId: viewer.id,
      viewerRole: viewer.role,
      viewerName: name,
      viewerClub: (club && club.name) || null,
      at: now,
      count: 1
    });
  }
  // Cap per player to the most recent 60 viewers to bound the collection.
  const viewsForPlayer = store.profile_views.filter((v) => v.playerId === player.id);
  if (viewsForPlayer.length > 60) {
    viewsForPlayer
      .sort((a, b) => (a.at || "").localeCompare(b.at || ""))
      .slice(0, viewsForPlayer.length - 60)
      .forEach((old) => {
        store.profile_views = store.profile_views.filter((v) => v.id !== old.id);
      });
  }
  db.save();
}

// Safe copy for the owner — never leaks another viewer's contact details.
function viewsFor(store, playerId) {
  return store.profile_views
    .filter((v) => v.playerId === playerId)
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
    .map((v) => ({
      id: v.id,
      viewerRole: v.viewerRole,
      viewerName: v.viewerName,
      viewerClub: v.viewerClub,
      at: v.at,
      count: v.count || 1
    }));
}

// POST /api/players  (player role, authenticated) — create own profile
router.post("/", requireAuth, requireActiveSub, (req, res) => {
  if (req.user.role !== "player") return res.status(403).json({ error: "Only player accounts can create player profiles" });
  const store = db.get();
  if (store.players.some((p) => p.userId === req.user.id)) {
    return res.status(409).json({ error: "You already have a profile" });
  }
    const guard = guardPlayerMedia(pickPlayer(req.body));
    if (!guard.ok) return res.status(400).json({ error: guard.error });
    const p = Object.assign(
      { id: "p_" + db.nextId("player"), slug: helpers.randomSlug(12), userId: req.user.id, postedDays: 0, rating: 0, reviews: 0, createdAt: new Date().toISOString() },
      guard.value
  );
  store.players.push(p);
  db.save();
  return res.status(201).json({ player: db.sanitizePlayer(p) });
});

// PUT /api/players/:id  (owner)
router.put("/:id", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  const p = store.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Player not found" });
  if (p.userId !== req.user.id) return res.status(403).json({ error: "Not your profile" });
    const guard = guardPlayerMedia(pickPlayer(req.body));
    if (!guard.ok) return res.status(400).json({ error: guard.error });
    Object.assign(p, guard.value, { id: p.id, userId: p.userId });
  // ANTI-GAMING: recency is server-computed from createdAt — a client-supplied
  // postedDays would let profiles pin themselves to the top of "newest" sort.
  delete p.postedDays;
  // Keep the search index fresh when any searchable field changed.
  p.keywords = helpers.buildKeywords([
    p.name, p.position, p.sport, p.currentClub,
    p.country, p.level, typeof p.stats === "string" ? p.stats : "", p.bio || ""
  ]);
  db.save();
  return res.json({ player: db.sanitizePlayer(p) });
});

// DELETE /api/players/:id  (owner)
router.delete("/:id", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  const idx = store.players.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Player not found" });
  if (store.players[idx].userId !== req.user.id) return res.status(403).json({ error: "Not your profile" });
  store.players.splice(idx, 1);
  store.reviews = store.reviews.filter((r) => r.playerId !== req.params.id);
  db.save();
  return res.json({ message: "Player profile deleted" });
});

/* POST /api/players/:id/review  { stars, comment }  (club accounts only)
   A club rates a player 1-5 stars with an optional comment. One review per
   club per player (re-rating updates in place). The player's aggregate
   rating/review-count is recomputed from the reviews collection. */
router.post("/:id/review", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  if (req.user.role !== "club") {
    return res.status(403).json({ error: "Only club accounts can rate players" });
  }
  const want = req.params.id;
  const p = store.players.find((x) => x.id === want || x.slug === want);
  if (!p || !db.profileApproved(p)) return res.status(404).json({ error: "Player not found" });
  if (p.userId === req.user.id) return res.status(400).json({ error: "لا يمكنك تقييم ملفك الخاص" });

  const stars = Math.round(Number(req.body && req.body.stars));
  if (!isFinite(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: "التقييم يجب أن يكون من 1 إلى 5 نجوم" });
  }
  const comment = String((req.body && req.body.comment) || "").trim().slice(0, 500);
  const club = store.clubs.find((c) => c.userId === req.user.id);
  const clubName = (club && club.name) || req.user.name || "نادي";

  const existing = store.reviews.find((r) => r.playerId === p.id && r.clubUserId === req.user.id);
  if (existing) {
    existing.stars = stars;
    existing.comment = comment;
    existing.updatedAt = new Date().toISOString();
  } else {
    store.reviews.push({
      id: "rev_" + db.nextId("review"),
      playerId: p.id,
      clubUserId: req.user.id,
      clubName,
      stars,
      comment,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  // Recompute the aggregate rating from the reviews collection.
  const all = store.reviews.filter((r) => r.playerId === p.id);
  p.reviews = all.length;
  p.rating = all.length ? +(all.reduce((s, r) => s + r.stars, 0) / all.length).toFixed(1) : 0;
  db.save();
  const review = store.reviews.find((r) => r.playerId === p.id && r.clubUserId === req.user.id);
  return res.json({ review, rating: p.rating, reviews: p.reviews });
});

/* POST /api/players/:id/shortlist  { in: boolean }  (club accounts only)
   Adds/removes a player from the club's private shortlist (for later
   side-by-side comparison). The list lives on the club document. */
router.post("/:id/shortlist", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  if (req.user.role !== "club") {
    return res.status(403).json({ error: "Only club accounts can use a shortlist" });
  }
  const club = store.clubs.find((c) => c.userId === req.user.id);
  if (!club) {
    return res.status(404).json({ error: "أنشئ ملف النادي أولاً لاستخدام القائمة المختصرة" });
  }
  const want = req.params.id;
  const p = store.players.find((x) => x.id === want || x.slug === want);
  if (!p || !db.profileApproved(p)) return res.status(404).json({ error: "Player not found" });

  if (!Array.isArray(club.shortlist)) club.shortlist = [];
  const inList = club.shortlist.indexOf(p.id) !== -1;
  const add = req.body && req.body.in !== false; // default: add
  if (add && !inList) club.shortlist.push(p.id);
  if (!add && inList) club.shortlist = club.shortlist.filter((id) => id !== p.id);
  db.save();
  return res.json({
    shortlisted: add,
    count: club.shortlist.length,
    playerId: p.id
  });
});

/* PUT /api/players/:id/scout-note  { note }  (club accounts only)
   Private scouting note about a player — visible only to the writing club.
   Empty note removes the entry. */
router.put("/:id/scout-note", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  if (req.user.role !== "club") {
    return res.status(403).json({ error: "Only club accounts can write scout notes" });
  }
  const club = store.clubs.find((c) => c.userId === req.user.id);
  if (!club) {
    return res.status(404).json({ error: "أنشئ ملف النادي أولاً لكتابة ملاحظات سكاوت" });
  }
  const want = req.params.id;
  const p = store.players.find((x) => x.id === want || x.slug === want);
  if (!p || !db.profileApproved(p)) return res.status(404).json({ error: "Player not found" });

  const note = String((req.body && req.body.note) || "").trim().slice(0, 1000);
  if (!club.scoutNotes) club.scoutNotes = {};
  if (note) club.scoutNotes[p.id] = note;
  else delete club.scoutNotes[p.id];
  db.save();
  return res.json({ note: note || null, playerId: p.id });
});

module.exports = router;