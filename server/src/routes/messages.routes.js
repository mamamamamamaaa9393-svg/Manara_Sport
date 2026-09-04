const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const requireActiveSub = require("../middleware/requireSub");
const { findContactAttempt } = require("../middleware/contactFilter");
const sub = require("../subscription");
const config = require("../config");

/* ==========================================================================
   Messaging rules
   1) Only a CLUB may initiate / send a message.
   2) A PLAYER can only REPLY to a club that already wrote to them in the
      same thread — players can never start a new conversation.
   3) Contact-solicitation phrases ("اعطيني رقمك", "الإيميل", whatsapp, …)
      are blocked for BOTH parties: the message is rejected and never saved.

   Thread scoping: every conversation is bound to ONE player profile via
   `playerId`. A club may open separate conversations with the SAME player
   account about DIFFERENT player profiles (e.g. the club talks to one club
   account that manages multiple athletes). The system must therefore treat
   `playerId` as the thread key — messages are never mixed across players
   even when the two user accounts (club ↔ player) are identical.
   ========================================================================== */

// The `playerId` of the thread is mandatory for a club. To stay compatible
// with older clients / legacy threads that did not send it, we resolve the
// last active thread automatically from the matching player's side.
function resolvePlayerId(store, me, peer, requestedPlayerId) {
  if (requestedPlayerId) return requestedPlayerId;
  // No explicit player -> pick the most recent thread involving these two
  // users, so reading/replying never bleeds into the *other* conversations
  // the same club opened with the same player account.
  const mine = store.messages
    .filter((m) =>
      (m.fromUserId === me.id && m.toUserId === peer) ||
      (m.fromUserId === peer && m.toUserId === me.id)
    )
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return mine.length ? (mine[0].playerId || null) : null;
}

// Did the club already write to this player inside THIS thread? The player
// can only reply in a thread the club already opened for that specific
// player profile.
function clubOpenedThread(store, clubUserId, playerUserId, playerId) {
  if (!playerId) return false;
  return store.messages.some((m) =>
    m.fromUserId === clubUserId &&
    m.toUserId === playerUserId &&
    m.playerId === playerId
  );
}

// GET /api/messages/threads — list conversations for the current user
router.get("/threads", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  const mine = store.messages.filter((m) => m.fromUserId === req.user.id || m.toUserId === req.user.id);
  const seen = new Set();
  const threads = [];
  mine.forEach((m) => {
    const peer = m.fromUserId === req.user.id ? m.toUserId : m.fromUserId;
    const key = (m.playerId || "") + "|" + peer;
    if (seen.has(key)) return;
    seen.add(key);
    const peerUser = store.users.find((u) => u.id === peer);
    const player = m.playerId ? store.players.find((p) => p.id === m.playerId) : null;
    // PRIVACY: thread peers get { id, role, name } only — db.publicUser
    // includes the account email, which must never be exposed to the other
    // party of a conversation.
    threads.push({
      key,
      peer: peerUser
        ? { id: peerUser.id, role: peerUser.role, name: peerUser.name || "" }
        : { id: peer },
      player: player ? db.publicPlayer(player) : null,
      lastMessage: m.text,
      lastAt: m.createdAt
    });
  });
  threads.sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || ""));
  return res.json({ threads });
});

// GET /api/messages?to=<userId>&player=<playerId> — conversation
// (participants only — never let an outsider read a thread). Reading a
// conversation marks every incoming message as read (drives the badge).
router.get("/", requireAuth, requireActiveSub, (req, res) => {
  const peer = req.query.to;
  if (!peer) return res.status(400).json({ error: "Missing ?to= participant id" });
  const store = db.get();
  // The counterpart must exist and be a legitimate conversation partner
  // (club↔player), otherwise probing random ids would be possible.
  const peerUser = store.users.find((u) => u.id === peer);
  const allowedPairing =
    peerUser &&
    ((req.user.role === "club" && peerUser.role === "player") ||
      (req.user.role === "player" && peerUser.role === "club"));
  if (!allowedPairing) {
    return res.status(403).json({ error: "You can only view your own conversations" });
  }
  // A brand-new thread (no messages yet) is a valid state — the club just
  // opened the player's profile and has not sent anything. Return an empty
  // conversation instead of a misleading 403.
  const participant = store.messages.some((m) =>
    (m.fromUserId === req.user.id && m.toUserId === peer) ||
    (m.fromUserId === peer && m.toUserId === req.user.id)
  );
  if (!participant) {
    return res.json({ messages: [], total: 0, page: 1, pages: 0 });
  }
  // Thread identity = playerId. When the client does not pass one (a legacy
  // first-open before any thread was tagged), resolve the active thread so we
  // still read ONE conversation — never a mix of every thread between these
  // two users.
  const playerId = resolvePlayerId(db.get(), req.user, peer, req.query.player || null);
  const list = store.messages
    .filter((m) =>
      (m.fromUserId === req.user.id && m.toUserId === peer) ||
      (m.fromUserId === peer && m.toUserId === req.user.id)
    )
    .filter((m) => m.playerId === playerId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  // Mark incoming messages as read (legacy messages without a read flag are
  // treated as already read — undefined !== false).
  let changed = false;
  list.forEach((m) => {
    if (m.fromUserId === peer && m.read === false) { m.read = true; changed = true; }
  });
  if (changed) db.save();

  const total = list.length;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const paginated = list.slice(offset, offset + limit);
  return res.json({ messages: paginated, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/messages/unread-count — badge counter for the nav Messages link.
router.get("/unread-count", requireAuth, requireActiveSub, (req, res) => {
  const store = db.get();
  const count = store.messages.filter(
    (m) => m.toUserId === req.user.id && m.read === false
  ).length;
  res.json({ count });
});

// POST /api/messages  { toUserId, playerId, text }
router.post("/", requireAuth, requireActiveSub, (req, res) => {
  let { toUserId, playerId, text } = req.body || {};
  if (!toUserId || !text || !String(text).trim()) {
    return res.status(400).json({ error: "toUserId and text are required" });
  }

  const store = db.get();
  const recipient = store.users.find((u) => u.id === toUserId);
  if (!recipient) return res.status(404).json({ error: "Recipient not found" });

  // Clubs talk to players; players only ever talk back to a club.
  if (req.user.role === "club" && recipient.role !== "player") {
    return res.status(400).json({ error: "Clubs can only message player accounts" });
  }
  if (req.user.role === "player" && recipient.role !== "club") {
    return res.status(400).json({ error: "Players can only reply to club accounts" });
  }

  // The linked player profile (if given) must belong to the party being
  // talked about: the recipient when a club writes, the sender when a
  // player replies about their own profile.
  if (playerId) {
    const pl = store.players.find((p) => p.id === playerId);
    if (!pl) return res.status(404).json({ error: "Player profile not found" });
    const expectedOwner = req.user.role === "club" ? toUserId : req.user.id;
    if (pl.userId !== expectedOwner) {
      return res.status(400).json({ error: "Player profile does not match the conversation party" });
    }
  }

  // THREAD SCOPING — every message belongs to exactly one player profile.
  // A club initiates a conversation about a specific player, so playerId is
  // mandatory (the "Message" button always passes it). A player replying is
  // scoped to the thread the club opened: if they don't pass the playerId we
  // resolve the active thread automatically so they never reply into the
  // wrong conversation with the same club.
  if (req.user.role === "club") {
    if (!playerId) {
      return res.status(400).json({ error: "يجب تحديد اللاعب المقصود بالرسالة (playerId) — ابدأ المحادثة من ملف اللاعب" });
    }
  } else if (req.user.role === "player") {
    // Resolve the thread the club opened with this player (the most recent
    // one mentioning any of the player's profiles) to scope the reply.
    const resolved = resolvePlayerId(store, req.user, toUserId, playerId || null);
    const pl = resolved ? store.players.find((p) => p.id === resolved) : null;
    if (!pl || pl.userId !== req.user.id) {
      return res.status(400).json({ error: "لا يمكن بدء محادثة جديدة — الرد فقط على المحادثة التي فتحها النادي حول ملفك" });
    }
    // Bind the resolved playerId onto the message so the reply lands in the
    // same thread.
    playerId = resolved;
  }

  // RULE 1 + 2 — a player may only REPLY to a club that already opened the thread.
  if (req.user.role === "player" && !clubOpenedThread(store, toUserId, req.user.id, playerId)) {
    return res.status(403).json({
      error: "يمكن للاعب الرد فقط على رسائل النادي — لا يمكنك بدء محادثة جديدة"
    });
  }

  // RULE 3 — contact-solicitation phrases are blocked for BOTH parties.
  const hit = findContactAttempt(text);
  if (hit) {
    return res.status(422).json({
      error: 'تم حظر الرسالة لأنها تطلب بيانات تواصل ("' + hit + '") — التواصل يتم داخل المنصة فقط.',
      blocked: true,
      matched: hit
    });
  }

  const msg = {
    id: "m_" + db.nextId("message"),
    fromUserId: req.user.id,
    toUserId,
    playerId: playerId || null,
    senderRole: req.user.role,
    text: String(text).slice(0, 2000),
    read: false,
    createdAt: new Date().toISOString()
  };
  store.messages.push(msg);
  db.save();
  return res.status(201).json({ message: msg });
});

module.exports = router;