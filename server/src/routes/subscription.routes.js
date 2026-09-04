const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const ai = require("../services/ai");
const sub = require("../subscription");
const receiptOcr = require("../receiptOcr");
const receiptDecide = require("../receiptDecide");
const config = require("../config");

const METHODS = ["vodafone_cash", "fawry"];
const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

function userTypeOf(user) {
  return sub.userTypeOf(user);
}

function loadUser(req, res, next) {
  const user = db.get().users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  req.userDoc = user;
  next();
}

// SHA-256 hash of a screenshot file (for duplicate-receipt detection).
// Resolves the /uploads/<name> URL to the local file under uploads/.
function screenshotHash(url) {
  if (!url || typeof url !== "string" || !url.startsWith("/uploads/")) return null;
  const name = path.basename(url);
  const file = path.join(UPLOAD_DIR, name);
  try {
    if (!fs.existsSync(file)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (e) {
    return null;
  }
}

function graceDaysLeft(user) {
  if (user.subscriptionStatus !== "past_due" || !user.paymentFailureAt) return 0;
  const end = new Date(user.paymentFailureAt).getTime() + require("../config").GRACE_DAYS * DAY;
  return Math.max(0, Math.ceil((end - Date.now()) / DAY));
}

// GET /api/subscription/status — trial + subscription + billing + one-shot
// milestone notifications. Applies lazy state transitions server-side.
router.get("/status", requireAuth, loadUser, async (req, res) => {
  const store = db.get();
  const u = req.userDoc;

  // Auto-cancel payment receipts stuck in pending past the window, then
  // lazily apply state transitions (trial -> expired, renewal grace, ...).
  sub.expireStalePending(store, Date.now());
  if (sub.refresh(u)) db.save();

  // Self-healing for online payments: if Kashier confirms a pending session
  // was actually paid (webhook lost), activate it before computing status.
  try {
    await require("../kashierReconcile").reconcilePendingKashier(u);
  } catch (e) {
    console.warn("[kashier] reconcile error:", e.message);
  }

  const status = sub.effectiveStatus(u, Date.now());
  // Expose the cancelled-at-period-end state at the top level too.
  // ("awaiting_review" is internal-only: the client already knows how to
  // render "pending", access enforcement happens server-side in hasAccess.)
  const effective = u.subscriptionStatus === "active" && u.cancelAtPeriodEnd && status === "active"
    ? "cancel_at_period_end"
    : status === "awaiting_review" ? "pending" : status;
  const active = sub.hasAccess(u);
  const type = userTypeOf(u);
  const price = sub.PRICES[type];
  const pendingTx = store.transactions.find((t) => t.userId === u.id && t.status === "pending") || null;
  const recentTx = store.transactions
    .filter((t) => t.userId === u.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0] || null;

  // Drain one-shot notifications (each milestone is delivered exactly once).
  const notes = u.pendingNotifications || [];
  u.pendingNotifications = [];
  if (notes.length) db.save();

  const trial = sub.trialInfo(u);

  let subscription = null;
  if (u.subscriptionStatus === "active" || u.subscriptionStatus === "past_due" || u.subscriptionExpiresAt) {
    subscription = {
      plan: u.plan || type,
      price: u.price != null ? u.price : price,
      currency: u.currency || sub.CURRENCY,
      status: u.subscriptionStatus === "active" && u.cancelAtPeriodEnd ? "cancel_at_period_end" : u.subscriptionStatus,
      periodStart: u.periodStart,
      periodEnd: u.subscriptionExpiresAt,
      nextBillingDate: u.nextBillingDate,
      cancelAtPeriodEnd: !!u.cancelAtPeriodEnd,
      renewalAttempts: u.renewalAttempts || 0,
      providerId: u.providerId || null,
      graceDaysLeft: graceDaysLeft(u)
    };
  }

  res.json({
    userType: type,
    plan: u.plan || type,
    price,
    currency: u.currency || sub.CURRENCY,
    status: effective,
    active,
    trial,
    subscription,
    billing: {
      interval: "monthly",
      renewal: "يُجدَّد الاشتراك تلقائياً كل 30 يوماً عبر الطريقة الموثقة لدى منارة.",
      cancellation: "يمكنك إلغاء الاشتراك في أي وقت — تبقى المزايا فعّالة حتى نهاية الفترة المدفوعة.",
      firstCharge: "أول دفعة تُسجَّل فقط بعد انتهاء فترة التجربة المجانية (" + (config.TRIAL_DAYS_BY_TYPE[type] || 7) + " أيام)."
    },
    // legacy keys kept for compatibility
    subscriptionStatus: effective,
    subscriptionExpiresAt: u.subscriptionExpiresAt,
    pendingTransaction: pendingTx,
    lastTransaction: recentTx,
    notifications: notes
  });
});

// POST /api/subscription/cancel — stop auto-renewal; access lasts until the
// end of the already-paid billing period.
router.post("/cancel", requireAuth, loadUser, (req, res) => {
  const u = req.userDoc;
  if (u.subscriptionStatus !== "active" || !u.subscriptionExpiresAt) {
    return res.status(400).json({ error: "لا يوجد اشتراك فعّال لإلغائه" });
  }
  sub.cancelSubscription(u);
  db.save();
  return res.json({
    message: "تم إلغاء التجديد التلقائي — تبقى المزايا مفعّلة حتى نهاية الفترة المدفوعة (" +
      new Date(u.subscriptionExpiresAt).toLocaleDateString("ar-EG") + ").",
    cancelAtPeriodEnd: true,
    subscriptionExpiresAt: u.subscriptionExpiresAt
  });
});

// POST /api/subscription/resume — re-enable auto-renewal before period end.
router.post("/resume", requireAuth, loadUser, (req, res) => {
  const u = req.userDoc;
  sub.resumeSubscription(u);
  db.save();
  return res.json({ message: "تمت إعادة تفعيل التجديد التلقائي.", cancelAtPeriodEnd: false });
});

/* POST /api/subscription/chat  { message }
   Paywall enforcement (server-side — never trust the client):
   - Access = active subscription OR active free trial (hasAccess; trial
     length per account type from config).
   - CLUB: cannot send anything without access.
   - GAMER: without access the FIRST message is free; the AI reply is stored
     with is_revealed=false and returned locked until the payment is approved.
*/
router.post("/chat", requireAuth, loadUser, async (req, res, next) => {
  try {
    const text = String((req.body && req.body.message) || "").trim();
    if (!text) return res.status(400).json({ error: "message is required" });
    if (text.length > 2000) return res.status(400).json({ error: "message is too long" });

    const store = db.get();
    const u = req.userDoc;
    const type = userTypeOf(u);
    const active = sub.hasAccess(u);

    if (type === "club" && !active) {
      return res.status(403).json({
        error: "فعّل اشتراك النادي أولاً (" + sub.PRICES.club + " ج.م شهرياً) لتتمكن من إرسال الرسائل",
        code: "subscribe_required",
        price: sub.PRICES.club
      });
    }

    if (type === "gamer" && !active) {
      const pendingLocked = store.ai_chats.find((m) => m.user_id === u.id && m.is_revealed === false);
      if (pendingLocked) {
        return res.status(402).json({
          error: "ردّك السابق لم يُفتح بعد — ادفع " + sub.PRICES.gamer + " ج.م لفتحه وإرسال المزيد",
          code: "reply_locked",
          price: sub.PRICES.gamer,
          chatId: pendingLocked.id,
          preview: ai.preview(pendingLocked.ai_response)
        });
      }
    }

    const reply = await ai.generateReply(text, u, type);
    const chat = {
      id: "ai_" + db.nextId("ai_chat"),
      user_id: u.id,
      user_type: type,
      message_text: text,
      ai_response: reply.text,
      ai_provider: reply.provider,
      is_revealed: active || type === "club",
      created_at: new Date().toISOString()
    };
    store.ai_chats.push(chat);
    db.save();

    if (chat.is_revealed) {
      return res.status(201).json({ chat });
    }
    return res.status(201).json({
      chat: { id: chat.id, user_type: chat.user_type, message_text: chat.message_text, is_revealed: false, created_at: chat.created_at },
      locked: true,
      code: "reply_locked",
      price: sub.PRICES.gamer,
      preview: ai.preview(chat.ai_response)
    });
  } catch (err) {
    next(err);
  }
});

/* POST /api/subscription/submit-payment
   { method, referenceNumber, screenshotUrl, amount }
   Automatic verification pipeline (server-side, never trust the client):
     1. Screenshot already screened at upload (tamper/format forensics).
     2. Duplicate detection: same reference / screenshot hash / screenshot URL
        already used by any approved/pending/rejected transaction.
     3. Amount match: user-entered amount == plan price (tolerance).
     4. OCR (Step 3): extract amount / date / reference / destination.
     5. Destination check (Step 2): OCR destination ∈ MANARA_WALLETS.
     6. Decision: approve (auto-activate) | manual (pending review) | reject
        (user may resubmit with corrected data — never a permanent lock).
   One pending transaction per user at a time. The user is NEVER charged
   during the free trial — the first charge only follows an active paid
   subscription.
*/
router.post("/submit-payment", requireAuth, loadUser, (req, res) => {
  const u = req.userDoc;
  const type = userTypeOf(u);
  const method = String((req.body && req.body.method) || "");
  const referenceNumber = String((req.body && req.body.referenceNumber) || "").trim().slice(0, 120);
  const screenshotUrl = String((req.body && req.body.screenshotUrl) || "").trim();
  const userAmount = Number((req.body && req.body.amount) || NaN);

  if (METHODS.indexOf(method) === -1) {
    return res.status(400).json({ error: "payment method must be one of: " + METHODS.join(", ") });
  }
  if (!screenshotUrl) {
    return res.status(400).json({ error: "يرجى رفع صورة إيصال الدفع أولاً (screenshotUrl)" });
  }
  if (!referenceNumber) {
    return res.status(400).json({ error: "أدخل رقم المحفظة أو الرقم المرجعي للتحقق" });
  }
  if (userAmount == null || !isFinite(userAmount) || userAmount <= 0) {
    return res.status(400).json({ error: "أدخل المبلغ المدفوع (يجب أن يطابق سعر الخطة)" });
  }

  const store = db.get();
  const existing = store.transactions.find((t) => t.userId === u.id && t.status === "pending");
  if (existing) {
    return res.status(409).json({
      error: "لديك طلب دفع معلّق بانتظار المراجعة (#" + existing.id + ")",
      transaction: existing
    });
  }

  // SECURITY: the screenshot must be an upload THIS user made. Otherwise an
  // attacker could point transactionScreenshot at another user's freshly
  // uploaded receipt (register-upload is unauthenticated and filenames are
  // semi-predictable) and get verified on someone else's genuine payment.
  if (screenshotUrl && screenshotUrl.startsWith("/uploads/")) {
    const rec = (store.uploads || []).find((x) => x.url === screenshotUrl);
    const owned = !rec || rec.uploadedBy === u.id; // legacy records w/o owner stay accepted
    if (!owned) {
      return res.status(403).json({ error: "صورة الإيصال يجب أن تكون مرفوعة من حسابك — ارفع الإيصال من صفحة الاشتراك." });
    }
  }

  const tx = {
    id: "tx_" + db.nextId("transaction"),
    userId: u.id,
    userType: type,
    userName: u.name,
    email: u.email,
    amount: sub.PRICES[type],
    currency: sub.CURRENCY,
    paymentMethod: method,
    transactionScreenshot: screenshotUrl,
    screenshotHash: screenshotHash(screenshotUrl),
    referenceNumber: referenceNumber,
    userAmount: userAmount,
    status: "pending",
    adminNote: null,
    reviewedAt: null,
    verification: null,
    createdAt: new Date().toISOString()
  };
  store.transactions.push(tx);
  if (!sub.hasAccess(u)) u.subscriptionStatus = "pending";
  db.save();

  // Run OCR + decision asynchronously, then finalize the transaction.
  const finish = (decision) => {
    tx.verification = {
      decision: decision.decision,
      code: decision.code,
      message: decision.message,
      ocrEnabled: config.OCR_ENABLED,
      ocrConfidence: decision.ocr ? decision.ocr.confidence || null : null,
      ocrFields: decision.ocr ? decision.ocr.fields || null : null,
      ocrReason: decision.ocr && !decision.ocr.ok ? decision.ocr.reason : null,
      duplicate: decision.duplicate || null,
      decidedAt: new Date().toISOString()
    };

    if (decision.decision === "approve") {
      // Auto-approve: activate the subscription + reveal pending replies.
      tx.status = "approved";
      tx.reviewedAt = new Date().toISOString();
      const base = db.isSubActive(u) ? u.subscriptionExpiresAt : new Date().toISOString();
      sub.activateSubscription(u, { from: base, plan: type });
      store.ai_chats
        .filter((m) => m.user_id === u.id && m.is_revealed === false)
        .forEach((m) => { m.is_revealed = true; });
      sub.notify(u, "✅ تم تفعيل اشتراكك",
        "تم التحقق من إيصالك تلقائياً — اشتراكك مفعّل حتى " +
        new Date(u.subscriptionExpiresAt).toLocaleDateString("ar-EG") + ".");
      db.save();
      return res.status(201).json({
        autoApproved: true,
        message: "✅ تم التحقق من الإيصال تلقائياً — اشتراكك مفعّل الآن!",
        transaction: tx
      });
    }

    if (decision.decision === "reject") {
      // Auto-reject with clear reason — the user can resubmit corrected data.
      tx.status = "rejected";
      tx.reviewedAt = new Date().toISOString();
      tx.adminNote = decision.message;
      if (u && !db.isSubActive(u) && !sub.hasAccess(u)) u.subscriptionStatus = "inactive";
      sub.notify(u, "❌ طلب الدفع مرفوض", decision.message.replace(/^❌\s*/, ""));
      db.save();
      return res.status(201).json({
        autoRejected: true,
        resubmitAllowed: true, // never a permanent lock
        message: decision.message,
        code: decision.code,
        transaction: tx
      });
    }

    // manual -> keep pending for the admin queue.
    tx.status = "pending";
    tx.adminNote = decision.message || null;
    sub.notify(u, "📩 طلب الدفع قيد المراجعة",
      "أرسلنا إيصالك (#" + tx.id + ") للإدارة للمراجعة — عادة تتم خلال ساعات.");
    // Flag the admin queue: a manual receipt needs a human review.
    sub.notifyAdmin(store, "🔔 إيصال جديد بانتظار المراجعة",
      "طلب دفع #" + tx.id + " من " + (u.name || u.email) + " (" + (type === "club" ? "نادي — 299 ج.م" : "لاعب — 39 ج.م") + ") — افتح لوحة الإدارة > الإيصالات.");
    db.save();
    return res.status(201).json({
      autoApproved: false,
      message: decision.message || "تم إرسال طلب الدفع — بانتظار مراجعة الإدارة.",
      transaction: tx
    });
  };

  // OCR requires the local file; fall back to manual if the file is missing.
  const localFile = screenshotUrl.startsWith("/uploads/")
    ? path.join(UPLOAD_DIR, path.basename(screenshotUrl))
    : null;
  if (!localFile || !fs.existsSync(localFile)) {
    return finish(receiptDecide.decide({
      store, tx, planPrice: sub.PRICES[type], userAmount,
      ocr: { ok: false, reason: "file_missing" }
    }));
  }

  receiptOcr.recognize(localFile, (ocr) => {
    const decision = receiptDecide.decide({
      store, tx, planPrice: sub.PRICES[type], userAmount, ocr
    });
    finish(decision);
  });
});

// GET /api/subscription/my-chats — the user's AI chats (reply revealed only
// after payment approval; otherwise preview text is returned).
router.get("/my-chats", requireAuth, loadUser, (req, res) => {
  const store = db.get();
  const list = store.ai_chats
    .filter((m) => m.user_id === req.userDoc.id)
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))
    .map((m) => ({
      id: m.id,
      user_type: m.user_type,
      message_text: m.message_text,
      is_revealed: m.is_revealed,
      ai_response: m.is_revealed ? m.ai_response : null,
      preview: m.is_revealed ? null : ai.preview(m.ai_response),
      created_at: m.created_at
    }));
  res.json({ chats: list });
});

module.exports = router;