const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { findContactAttempt } = require("../middleware/contactFilter");
const sub = require("../subscription");
const config = require("../config");

// GET /api/applications — clubs see incoming offers for their target players;
// players see their own offers.
router.get("/", requireAuth, (req, res) => {
  const store = db.get();
  let list;
  if (req.user.role === "club") {
    // A club sees every application it sent (its own offers)
    list = store.applications.filter((a) => a.clubUserId === req.user.id);
  } else {
    const me = store.players.find((p) => p.userId === req.user.id);
    list = me ? store.applications.filter((a) => a.playerId === me.id) : [];
  }
  list = list
    .map((a) => {
      const player = store.players.find((p) => p.id === a.playerId);
      // SECURITY: the viewing account is a CLUB (non-owner of the player), so
      // contact data + official documents must be masked — never the raw
      // sanitizePlayer copy which only strips _password and leaks PII/docs.
      return Object.assign({}, a, { player: player ? db.maskPlayer(player) : null });
    })
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return res.json({ applications: list });
});

// POST /api/applications  { playerId, type: transfer|tryout|scout, message }
// SECURITY: applications carry free-text offers to players, so they are gated
// behind the same subscription paywall and the same contact-solicitation
// filter as direct messages (a lapsed club could otherwise spam players with
// phone numbers / WhatsApp invites indefinitely).
router.post("/", requireAuth, (req, res) => {
  if (req.user.role !== "club") return res.status(403).json({ error: "Only clubs can send applications" });
  const { playerId, type, message } = req.body || {};
  const store = db.get();
  const player = store.players.find((p) => p.id === playerId);
  if (!player) return res.status(404).json({ error: "Player not found" });

  // Premium gate (mirrors messages.routes.js)
  const sender = store.users.find((x) => x.id === req.user.id);
  if (sender && !sub.hasAccess(sender)) {
    return res.status(403).json({
      error: "فعّل اشتراك النادي أو استفد من التجربة المجانية (" + (config.TRIAL_DAYS_BY_TYPE.club || 7) + " أيام) لإرسال العروض",
      code: "subscribe_required"
    });
  }

  // Contact-solicitation filter (RULE 3)
  const hit = findContactAttempt(String(message || ""));
  if (hit) {
    return res.status(422).json({
      error: 'تم حظر العرض لأنه يحتوي على بيانات تواصل ("' + hit + '") — التواصل يتم داخل المنصة فقط.',
      blocked: true,
      matched: hit
    });
  }

  const app = {
    id: "a_" + db.nextId("application"),
    clubUserId: req.user.id,
    playerId,
    type: ["transfer", "tryout", "scout"].indexOf(type) === -1 ? "scout" : type,
    message: String(message || "").slice(0, 2000),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  store.applications.push(app);
  db.save();
  return res.status(201).json({ application: app });
});

// PATCH /api/applications/:id/status  { status }  (club owner)
router.patch("/:id/status", requireAuth, (req, res) => {
  const store = db.get();
  const app = store.applications.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "Application not found" });
  if (app.clubUserId !== req.user.id) return res.status(403).json({ error: "Not your application" });
  const status = req.body.status;
  if (["pending", "accepted", "rejected", "done"].indexOf(status) === -1) {
    return res.status(400).json({ error: "Invalid status" });
  }
  app.status = status;
  if (status === "accepted") {
    const player = store.players.find((p) => p.id === app.playerId);
    if (player) player.available = false;
  }
  db.save();
  return res.json({ application: app });
});

module.exports = router;