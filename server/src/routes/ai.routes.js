/* ==========================================================================
   Manara AI Assistant — API endpoint.
   POST /api/ai/chat
   - Requires authentication (reuses the existing JWT auth middleware).
   - Validates input (non-empty, length-bounded).
   - Per-user rate limit to prevent abuse.
   - Runs the Manara-only guard server-side; off-topic questions are rejected
     with a fixed message and never sent to the model.
   - The AI provider key stays server-side and is never returned to clients.
   ========================================================================== */
const router = require("express").Router();
const rateLimit = require("../middleware/rateLimit");
const { requireAuth } = require("../middleware/auth");
const requireActiveSub = require("../middleware/requireSub");
const { manaraChat } = require("../ai/manaraChat");

const MAX_LEN = Number(process.env.AI_MAX_MESSAGE_LENGTH || 2000);

// Per authenticated user; falls back to IP for safety.
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  message: "طلبات كثيرة إلى المساعد — حاول بعد قليل",
  key: (req) => (req.user && req.user.id) || (req.ip || "unknown")
});

router.post("/chat", requireAuth, requireActiveSub, chatLimiter, async (req, res) => {
  try {
    const message = String((req.body && req.body.message) || "").trim();
    const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(0, 12) : [];

    if (!message) {
      return res.status(400).json({ error: "الرسالة لا يمكن أن تكون فارغة" });
    }
    if (message.length > MAX_LEN) {
      return res.status(400).json({ error: "الرسالة طويلة جداً — الحد الأقصى " + MAX_LEN + " حرف" });
    }

    const result = await manaraChat({ message: message, history: history, user: req.user });

    // Minimal, safe logging: NEVER log message content, tokens, or the key.
    console.log(`[ai] user=${(req.user && req.user.id) || "?"} scope=${result.scope} provider=${result.provider} len=${message.length}`);

    return res.json(result);
  } catch (e) {
    console.error("[ai] error", e && e.message);
    return res.status(500).json({ error: "تعذر معالجة طلبك الآن — حاول لاحقاً" });
  }
});

module.exports = router;
