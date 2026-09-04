const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { matchPlayersForClub, matchClubsForPlayer } = require("../matching");

/* ==========================================================================
   Manara — Smart Matching routes.

   SECURITY & SEPARATION (do not regress):
   - Gating = requireAuth ONLY. This route file NEVER imports requireActiveSub
     or the subscription engine, and never checks subscriptionStatus. The
     matching feature therefore cannot be used to bypass the paywall.
   - Privacy is enforced at OUTPUT time by the per-viewer serialization used
     across the app:
        * a club viewing players  -> db.maskPlayer (contact masked, docs hidden)
        * a player/admin viewing players -> db.publicPlayer (contact stripped)
        * clubs viewed by anyone  -> db.publicClub (club contact/docs stripped)
     Only profiles that passed db.profileApproved are ever returned.
   ========================================================================== */

function store() {
  const s = db.get();
  s.players = s.players || [];
  s.clubs = s.clubs || [];
  return s;
}

// ---- Club -> recommended players ----------------------------------------
// For a CLUB account: scouting-masked players ranked by fit against the club's
// own profile or explicit overrides. Free-text `text` enables semantic search.
router.get("/players-for-club", requireAuth, (req, res) => {
  if (req.user.role !== "club") {
    return res.status(403).json({ error: "Only club accounts can get player recommendations" });
  }
  const s = store();
  const club = s.clubs.find((c) => c.userId === req.user.id);
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 10));

  const matches = matchPlayersForClub({
    players: s.players,
    approved: (p) => db.profileApproved(p),
    sport: req.query.sport || (club && club.sport),
    position: req.query.neededPosition || (club && club.neededPosition),
    country: req.query.country || (club && club.country),
    city: req.query.city || (club && club.city),
    text: req.query.q,
    limit
  });

  const masked = matches.map((m) => Object.assign(db.maskPlayer(m.profile), { score: m.score }));
  return res.json({ matches: masked, limit });
});

// ---- Player -> recommended clubs ----------------------------------------
// For a PLAYER (or admin) account: public clubs ranked by fit against the
// player's own profile or explicit overrides.
router.get("/clubs-for-player", requireAuth, (req, res) => {
  if (req.user.role !== "player" && req.user.role !== "admin") {
    return res.status(403).json({ error: "Only player accounts can get club recommendations" });
  }
  const s = store();
  const player = s.players.find((p) => p.userId === req.user.id);
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 10));

  const matches = matchClubsForPlayer({
    clubs: s.clubs,
    approved: (c) => db.profileApproved(c),
    sport: req.query.sport || (player && player.sport),
    position: req.query.position || (player && player.position),
    country: req.query.country || (player && player.country),
    level: req.query.level || (player && player.level),
    text: req.query.q,
    limit
  });

  const publicOut = matches.map((m) => Object.assign(db.publicClub(m.profile), { score: m.score }));
  return res.json({ matches: publicOut, limit });
});

module.exports = router;
