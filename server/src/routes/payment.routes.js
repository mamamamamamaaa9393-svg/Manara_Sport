/* ==========================================================================
   Manara — Kashier online payment routes.
   - POST /api/payments/kashier/checkout  (auth) -> creates a Kashier payment
     session for the user's plan price and returns the secure checkout URL.
   - POST /api/payments/kashier/webhook   (Kashier -> us, HMAC-verified) ->
     activates the subscription on a successful payment.
   The manual receipt flow (/api/subscription/submit-payment) stays intact —
   online payment is an additional, faster channel.
   ========================================================================== */
const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const sub = require("../subscription");
const kashier = require("../kashier");
const config = require("../config");

const SITE_URL = String(process.env.SITE_URL || "http://localhost:5000").replace(/\/$/, "");
const MODE = kashier.MODE;

function loadUser(req, res, next) {
  const user = db.get().users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  req.userDoc = user;
  next();
}

/* POST /api/payments/kashier/checkout — build a payment session for the
   authenticated user. Reuses the same server-side price as the manual flow. */
router.post("/kashier/checkout", requireAuth, loadUser, async (req, res, next) => {
  try {
    /* Paywall disabled: never create a payment session (no money is taken). */
    if (!config.BILLING_ENABLED) {
      return res.status(503).json({ error: "نظام الاشتراك معطّل حالياً" });
    }
    if (!kashier.enabled()) {
      return res.status(503).json({ error: "بوابة الدفع الإلكتروني غير مفعّلة حالياً — استخدم التحويل اليدوي" });
    }

    // Reconcile first: a previous session may already be paid (webhook lost).
    // If so, activate and the "already active" check below stops the retry —
    // a retry must never cancel an already-paid session.
    await require("../kashierReconcile").reconcilePendingKashier(req.userDoc);

    const store = db.get();
    const u = req.userDoc;
    const type = sub.userTypeOf(u);
    const price = sub.PRICES[type];

    if (u.subscriptionStatus === "active" && u.subscriptionExpiresAt &&
        new Date(u.subscriptionExpiresAt).getTime() > Date.now()) {
      return res.status(400).json({ error: "اشتراكك نشط بالفعل — لا حاجة للدفع الآن" });
    }

    // A previous online session that was never paid is replaced.
    store.transactions.forEach((t) => {
      if (t.userId === u.id && t.paymentMethod === "kashier" && t.status === "pending_kashier") {
        t.status = "cancelled";
        t.adminNote = "استُبدل بجلسة دفع أونلاين أحدث";
        t.reviewedAt = new Date().toISOString();
      }
    });

    const tx = {
      id: "tx_" + db.nextId("transaction"),
      userId: u.id,
      userType: type,
      userName: u.name,
      email: u.email,
      amount: price,
      currency: sub.CURRENCY,
      paymentMethod: "kashier",
      orderId: "MAN-" + u.id + "-" + Date.now(),
      status: "pending_kashier",
      adminNote: null,
      reviewedAt: null,
      verification: null,
      createdAt: new Date().toISOString()
    };
    store.transactions.push(tx);
    db.save();

    let redirectUrl = (process.env.KASHIER_REDIRECT_URL || SITE_URL + "/subscribe.html?kashier=1").replace(/\/$/, "");
    let webhookUrl = (process.env.KASHIER_WEBHOOK_URL || SITE_URL + "/api/payments/kashier/webhook").replace(/\/$/, "");
    if (/localhost|127\.0\.0\.1/.test(redirectUrl) || /localhost|127\.0\.0\.1/.test(webhookUrl)) {
      // Kashier rejects loopback URLs. In local dev the redirect/webhook won't
      // reach this machine anyway — substitute the production placeholder so
      // the checkout page can still be opened (set KASHIER_REDIRECT_URL /
      // KASHIER_WEBHOOK_URL, e.g. an ngrok tunnel, to test the full flow).
      console.warn("[kashier] loopback URL — substituting production placeholder (set KASHIER_REDIRECT_URL/KASHIER_WEBHOOK_URL to test locally)");
      redirectUrl = "https://manarasport.com/subscribe.html?kashier=1";
      webhookUrl = "https://manarasport.com/api/payments/kashier/webhook";
    }

    const session = await kashier.createSession({
      order: tx.orderId,
      amount: price,
      currency: sub.CURRENCY,
      email: u.email,
      reference: u.id,
      redirectUrl,
      webhookUrl,
      description: "اشتراك " + (type === "club" ? "النادي" : "اللاعب") + " — " + price + " " + sub.CURRENCY
    });

    if (!session || !session.sessionUrl) {
      throw new Error("Kashier did not return a session URL");
    }

    tx.sessionId = session._id || null;
    db.save();

    return res.json({
      sessionUrl: session.sessionUrl,
      order: tx.orderId,
      amount: price,
      currency: sub.CURRENCY,
      mode: MODE
    });
  } catch (err) {
    // The pending session is unusable — cancel it so the user can retry.
    const tx = db.get().transactions.find((t) => t.orderId && t.userId === req.user.id && t.status === "pending_kashier");
    if (tx) {
      tx.status = "cancelled";
      tx.adminNote = "فشل إنشاء جلسة الدفع: " + String(err.message || "").slice(0, 200);
      tx.reviewedAt = new Date().toISOString();
      db.save();
    }
    console.error("[kashier] checkout failed:", err.message);
    return res.status(502).json({ error: "تعذر فتح بوابة الدفع الآن — أعد المحاولة أو استخدم التحويل اليدوي" });
  }
});

/* POST /api/payments/kashier/webhook — Kashier payment notification.
   Signature is verified with the Payment API key (HMAC-SHA256). */
router.post("/kashier/webhook", async (req, res) => {
  // SECURITY: Kashier must be configured with a real API key. When the key is
  // unset it defaults to "" (kashier.js:12), so an attacker could compute
  // HMAC_SHA256("", payload) themselves and forge a SUCCESS webhook that
  // activates any subscription for free. Reject outright if not configured —
  // mirrors the 503 guard used by the generic webhook.routes.js.
  if (!kashier.enabled()) {
    console.warn("[kashier] webhook received but Kashier is not configured — refusing");
    return res.status(503).json({ error: "Payment provider not configured" });
  }
  const body = req.body || {};
  const signature = String(req.headers["x-kashier-signature"] || "");
  const data = body.data || {};

  if (!kashier.verifyWebhookSignature(body, signature)) {
    console.warn("[kashier] webhook signature mismatch — ignoring");
    return res.status(401).json({ error: "invalid signature" });
  }

  const store = db.get();
  const tx = store.transactions.find((t) => t.orderId === data.merchantOrderId);
  if (!tx) {
    console.warn("[kashier] webhook for unknown order " + data.merchantOrderId);
    return res.status(404).json({ error: "unknown order" });
  }
  if (tx.status !== "pending_kashier") {
    // Already processed (approved/cancelled) — acknowledge to stop retries.
    return res.json({ received: true, duplicate: true });
  }

  if (body.event === "pay" && data.status === "SUCCESS") {
    // Kashier reports the amount in the smallest currency unit (piasters).
    const paid = Number(data.amount) / 100;
    const expected = tx.amount;
    if (!isFinite(paid) || Math.abs(paid - expected) > expected * 0.01) {
      tx.status = "rejected";
      tx.adminNote = "مبلغ غير مطابق عبر كاشير: دُفع " + paid + " بدلاً من " + expected + " " + sub.CURRENCY;
      tx.reviewedAt = new Date().toISOString();
      tx.verification = { provider: "kashier", event: body.event, status: data.status, method: data.method || null, transactionId: data.transactionId || null };
      const u = store.users.find((x) => x.id === tx.userId);
      if (u) sub.notify(u, "⚠️ مشكلة في الدفع عبر كاشير", "المبلغ المدفوع (" + paid + " ج.م) لا يطابق سعر خطتك (" + expected + " ج.م) — تواصل مع الدعم.");
      db.save();
      return res.json({ received: true, decision: "rejected" });
    }

    const user = store.users.find((x) => x.id === tx.userId);
    if (!user) {
      return res.status(404).json({ error: "user not found" });
    }

    tx.status = "approved";
    tx.reviewedAt = new Date().toISOString();
    tx.providerId = data.transactionId || null;
    tx.verification = {
      provider: "kashier",
      event: body.event,
      status: data.status,
      method: data.method || null,
      transactionId: data.transactionId || null,
      kashierOrderId: data.kashierOrderId || null,
      responseCode: data.transactionResponseCode || null
    };

    sub.activateSubscription(user, { providerId: "kashier:" + (tx.providerId || tx.id) });
    sub.notify(user, "✅ تم تفعيل اشتراكك", "تم تأكيد الدفع عبر كاشير — اشتراكك نشط لمدة 30 يوماً.");
    db.save();

    console.log("[kashier] payment approved — order " + tx.orderId + " (" + data.transactionId + ")");
    return res.json({ received: true, decision: "approved" });
  }

  // pay event without SUCCESS (failed/cancelled by user) — leave pending.
  return res.json({ received: true, event: body.event, status: data.status });
});

module.exports = router;