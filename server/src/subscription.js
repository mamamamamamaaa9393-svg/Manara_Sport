/* ==========================================================================
   Manara subscription engine.
   Single source of truth for the SaaS lifecycle:

     Registration -> approval -> FREE TRIAL (backend-controlled,
     TRIAL_DAYS_CLUB / TRIAL_DAYS_GAMER in config) -> (choose plan)
     -> verified payment -> ACTIVE monthly subscription
        -> renewal (paid) / past_due (grace) / expired / cancelled-at-period-end

   Security rules enforced here:
     - Trial dates are server-side (never from the client clock).
     - hasAccess() is the ONLY authorization gate (no frontend trust).
     - Prices/plans come from config, never from the client.
     - Expiration is computed from stored dates, lazily persisted.
   ========================================================================== */
const db = require("./db");
const config = require("./config");
const { TRIAL_DAYS, TRIAL_DAYS_BY_TYPE, GRACE_DAYS, BILLING_DAYS, PRICES, CURRENCY, PENDING_EXPIRY_HOURS } = require("./config");

const DAY = 24 * 60 * 60 * 1000;

function userTypeOf(user) {
  return user.userType || (user.role === "club" ? "club" : "gamer");
}

function hasPendingTransaction(userId) {
  return db.get().transactions.some((t) => t.userId === userId && t.status === "pending");
}

/* Push an in-app notification. Delivered once when the user's next
   /api/subscription/status call drains pendingNotifications. */
function notify(user, title, message) {
  if (!user) return false;
  user.pendingNotifications = user.pendingNotifications || [];
  user.pendingNotifications.push({
    code: "general",
    title: String(title || ""),
    message: String(message || ""),
    at: new Date().toISOString()
  });
  return true;
}

/* Notify every admin account (used to flag manual payment receipts that need
   a human review). Drained by the admin transactions endpoint. */
function notifyAdmin(store, title, message) {
  if (!store || !Array.isArray(store.users)) return 0;
  let sent = 0;
  store.users.forEach((u) => {
    if (u && u.role === "admin") {
      if (notify(u, title, message)) sent++;
    }
  });
  return sent;
}

/* Auto-cancel payment receipts stuck in `pending` longer than the configured
   window, so the admin queue never fills with stale reviews and the user can
   resubmit a fresh request. Cancelled transactions are excluded from
   duplicate detection (receiptDecide only counts approved/pending), so a
   cancelled reference is immediately reusable. Returns how many expired. */
function expireStalePending(store, now) {
  if (!store || !Array.isArray(store.transactions)) return 0;
  const maxAge = PENDING_EXPIRY_HOURS * 60 * 60 * 1000;
  let expired = 0;
  (store.transactions || []).forEach((tx) => {
    if (!tx || tx.status !== "pending") return;
    const created = tx.createdAt ? new Date(tx.createdAt).getTime() : 0;
    if (!created || now - created <= maxAge) return;
    tx.status = "cancelled";
    tx.reviewedAt = new Date(now).toISOString();
    tx.adminNote = "انتهت صلاحية طلب الدفع تلقائياً (لم يُراجع خلال " + PENDING_EXPIRY_HOURS + " ساعة)";
    expired++;
    const user = store.users.find((u) => u.id === tx.userId);
    if (user) {
      notify(user, "⏳ انتهت صلاحية طلب الدفع #" + tx.id,
        "لم تتم مراجعة طلبك خلال " + PENDING_EXPIRY_HOURS + " ساعة — يمكنك إرسال طلب دفع جديد في أي وقت.");
      const stillPending = store.transactions.some(
        (t) => t.userId === user.id && t.status === "pending"
      );
      if (!stillPending && !db.isSubActive(user)) {
        const trialLive = user.trialEnd && new Date(user.trialEnd).getTime() > now;
        if (!trialLive && ["pending", "past_due"].indexOf(user.subscriptionStatus) !== -1) {
          user.subscriptionStatus = "inactive";
        }
      }
    }
  });
  if (expired) db.save();
  return expired;
}

/* Pure status computation for a user at `now` (ms). Never mutates. */
function effectiveStatus(user, now) {
  if (!user) return "inactive";
  if (user.role === "admin") return "active";

  const expires = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).getTime() : 0;

  // Paid subscription still inside its billing period.
  if (user.subscriptionStatus === "active" && expires > now) return "active";

  // The billing period ended and no verified renewal arrived yet -> grace.
  if (user.subscriptionStatus === "active" && expires > 0) return "past_due";

  // Already in the grace period (or past it).
  if (user.subscriptionStatus === "past_due") {
    const failAt = user.paymentFailureAt ? new Date(user.paymentFailureAt).getTime() : now;
    return now <= failAt + GRACE_DAYS * DAY ? "past_due" : "expired";
  }

  // A payment was submitted and is awaiting admin verification. By default
  // this NO LONGER grants premium access (a fabricated-receipt loop could
  // otherwise renew free access forever). Set PENDING_GRANTS_ACCESS=true in
  // .env to restore the lenient behaviour.
  if (user.subscriptionStatus === "pending" && hasPendingTransaction(user.id)) {
    return config.PENDING_GRANTS_ACCESS ? "pending" : "awaiting_review";
  }

  // Active free trial (server dates only; length per account type in config).
  if (user.trialEnd && new Date(user.trialEnd).getTime() > now) return "trialing";

  return "expired";
}

/* Authorized to use premium features? Used by every paywall gate. */
function hasAccess(user) {
  const s = effectiveStatus(user, Date.now());
  return s === "active" || s === "trialing" || s === "past_due" ||
    (s === "pending" && config.PENDING_GRANTS_ACCESS);
}

function trialInfo(user) {
  if (!user || !user.trialStart || !user.trialEnd) return null;
  const startMs = new Date(user.trialStart).getTime();
  const end = new Date(user.trialEnd).getTime();
  const now = Date.now();
  const totalDays = isFinite(startMs) && end > startMs
    ? Math.max(1, Math.round((end - startMs) / DAY))
    : Math.max(1, Math.round((end - now) / DAY));
  return {
    started: true,
    start: user.trialStart,
    end: user.trialEnd,
    days: totalDays,
    daysLeft: Math.max(0, Math.ceil((end - now) / DAY)),
    expired: now > end
  };
}

/* Start (or lazily grant) the free trial. Server clock is authoritative.
   Trial length depends on the account type: club -> 7 days, player -> 2 days.
   Set once when the account is created/approved — never restarted on login. */
function startTrial(user) {
  const now = new Date();
  const type = userTypeOf(user);
  const days = TRIAL_DAYS_BY_TYPE[type] || TRIAL_DAYS;
  user.trialStart = now.toISOString();
  user.trialEnd = new Date(now.getTime() + days * DAY).toISOString();
  user.trialNotified = {};
  if (!user.subscriptionStatus || ["inactive", "expired", ""].indexOf(user.subscriptionStatus) !== -1) {
    user.subscriptionStatus = "trialing";
  }
}

/* Activate a paid subscription for one billing period. `from` = period start
   (defaults to the current period end if still in the future, else now). */
function activateSubscription(user, opts) {
  const now = new Date();
  const stillValid = user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > now.getTime();
  const base = opts && opts.from ? new Date(opts.from) : (stillValid ? new Date(user.subscriptionExpiresAt) : now);
  const periodEnd = new Date(base.getTime() + BILLING_DAYS * DAY);

  user.subscriptionStatus = "active";
  user.subscriptionExpiresAt = periodEnd.toISOString();
  user.periodStart = base.toISOString();
  user.nextBillingDate = periodEnd.toISOString();
  user.cancelAtPeriodEnd = false;
  user.plan = (opts && opts.plan) || userTypeOf(user);
  user.price = PRICES[user.plan] || PRICES[userTypeOf(user)];
  user.currency = CURRENCY;
  if (opts && opts.providerId != null) user.providerId = opts.providerId;
  if (opts && opts.providerCustomerId != null) user.providerCustomerId = opts.providerCustomerId;
  user.renewalAttempts = 0;
  user.paymentFailureAt = null;
}

/* Cancel at the end of the already-paid billing period (access stays). */
function cancelSubscription(user) {
  if (user.subscriptionStatus === "active") user.cancelAtPeriodEnd = true;
}

function resumeSubscription(user) {
  user.cancelAtPeriodEnd = false;
}

function markPastDue(user) {
  user.subscriptionStatus = "past_due";
  user.paymentFailureAt = new Date().toISOString();
  user.renewalAttempts = (user.renewalAttempts || 0) + 1;
}

function markExpired(user) {
  if (user.subscriptionStatus !== "active" && user.subscriptionStatus !== "pending") {
    user.subscriptionStatus = "expired";
  }
}

/* One-time trial milestone messages. Each milestone is fired exactly once,
   tracked server-side in user.trialNotified. Returned messages are appended
   to user.pendingNotifications and drained by /api/subscription/status. */
function collectTrialNotifications(user, now) {
  if (!user || !user.trialStart || !user.trialEnd) return [];
  const n = user.trialNotified || (user.trialNotified = {});
  const end = new Date(user.trialEnd).getTime();
  const total = end - new Date(user.trialStart).getTime();
  const diff = end - now;
  const out = [];
  const push = (code, title, message) => {
    out.push({ code, title, message });
    n[code] = true;
  };

  if (!n.trial_started && diff > 0) {
    push("trial_started", "مرحباً بك في منارة 🎉", "انطلق حسابك مع " + Math.ceil(total / DAY) + " يوم من التجربة المجانية الكاملة — بلا أي رسوم.");
  }
  if (total > 3 * DAY && diff <= 3 * DAY && !n.trial_3) {
    push("trial_3", "تجربتك تقترب من النهاية ⏳", "تبقى 3 أيام فقط على نهاية تجربتك المجانية.");
  }
  if (diff <= DAY && !n.trial_1) {
    push("trial_1", "آخر يوم في تجربتك 🌙", "اشترك الآن قبل انتهاء التجربة لتفادي انقطاع المزايا.");
  }
  if (now > end && !hasAccess(user) && !n.trial_expired) {
    push("trial_expired", "انتهت تجربتك المجانية", "اشترك شهرياً لتستمر في استخدام المزايا المميزة.");
  }
  return out;
}

/* In-app expiry reminders (mirrors the email reminder in expiryReminderNeeded).
   Fires exactly ONCE per period: when an active paid subscription or a live
   trial is within EXPIRY_REMINDER_DAYS of its end. Tracked per period-end ISO
   in user.expiryNotified, so renewing resets and the next period re-arms it. */
function collectExpiryNotifications(user, now) {
  if (!user || user.role === "admin") return [];
  const n = user.expiryNotified || (user.expiryNotified = {});
  const end = (() => {
    if (user.subscriptionStatus === "active" && user.subscriptionExpiresAt) return user.subscriptionExpiresAt;
    if (user.trialEnd && new Date(user.trialEnd).getTime() > now) return user.trialEnd;
    return null;
  })();
  if (!end) return out();
  const endMs = new Date(end).getTime();
  const daysLeft = Math.ceil((endMs - now) / DAY);
  if (daysLeft <= 0 || daysLeft > EXPIRY_REMINDER_DAYS || n[end]) return out();
  n[end] = true;
  const isTrial = user.subscriptionStatus !== "active";
  const price = user.price != null ? user.price : PRICES[userTypeOf(user)];
  return [{
    code: "expiry_soon",
    title: isTrial ? "⏳ تجربتك تنتهي قريباً" : "⏳ اشتراكك يقارب الانتهاء",
    message: isTrial
      ? "تبقى " + daysLeft + " يوم على نهاية تجربتك المجانية — اشترك (" + price + " ج.م/شهر) قبل انتهائها لتفادي انقطاع المزايا."
      : "تبقى " + daysLeft + " يوم على نهاية اشتراكك (" + price + " ج.م/شهر) — جدّد قبل انتهاء الفترة المدفوعة."
  }];
  function out() { return []; }
}

/* Lazily persist state transitions + collect milestone notifications.
   Returns true if the user document changed (caller persists once). */
function refresh(user) {
  if (!user || user.role === "admin") return false;
  const now = Date.now();
  let changed = false;
  const set = (k, v) => { if (user[k] !== v) { user[k] = v; changed = true; } };

  // Eligible approved user with no trial and no paid history -> start trial.
  if (user.approved !== false && !user.trialStart && !hasPendingTransaction(user.id)) {
    const stillPaid = user.subscriptionStatus === "active" &&
      user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > now;
    if (!stillPaid) {
      startTrial(user);
      changed = true;
    }
  }

  const status = effectiveStatus(user, now);

  if (status === "past_due" && user.subscriptionStatus !== "past_due") {
    set("subscriptionStatus", "past_due");
    set("paymentFailureAt", new Date(now).toISOString());
    set("renewalAttempts", (user.renewalAttempts || 0) + 1);
  } else if (status === "expired" && ["inactive", "trialing"].indexOf(user.subscriptionStatus) !== -1) {
    set("subscriptionStatus", "expired");
  } else if (status === "trialing" && user.subscriptionStatus !== "trialing") {
    set("subscriptionStatus", "trialing");
  }

  const notes = collectTrialNotifications(user, now);
  if (notes.length) {
    user.pendingNotifications = user.pendingNotifications || [];
    user.pendingNotifications.push(...notes);
    changed = true;
  }

  const expNotes = collectExpiryNotifications(user, now);
  if (expNotes.length) {
    user.pendingNotifications = user.pendingNotifications || [];
    user.pendingNotifications.push(...expNotes);
    changed = true;
  }

  return changed;
}

/* Sweep every user (called periodically by the server). Persists once when
   anything changed. Also auto-cancels stale pending receipts first. */
function refreshAll() {
  const store = db.get();
  let changed = false;
  expireStalePending(store, Date.now());
  (store.users || []).forEach((u) => { if (refresh(u)) changed = true; });
  if (changed) db.save();
}

/* --------------------------------------------------------------------------
   Expiry reminders (email).
   For every user with an active paid subscription or an active trial that is
   about to expire (within EXPIRY_REMINDER_DAYS), send exactly ONE reminder
   email per period. Tracks `user.expiryEmailSent` = the period-end ISO the
   email was sent for, so renewing resets the flag and a new reminder fires
   only for the NEXT period.
   -------------------------------------------------------------------------- */
const { EXPIRY_REMINDER_DAYS } = require("./config");

function expiryReminderNeeded(user, now) {
  if (!user || user.role === "admin") return false;
  const end = (() => {
    if (user.subscriptionStatus === "active" && user.subscriptionExpiresAt) return user.subscriptionExpiresAt;
    if (user.trialEnd && new Date(user.trialEnd).getTime() > now) return user.trialEnd;
    return null;
  })();
  if (!end) return false;
  const endMs = new Date(end).getTime();
  if (endMs <= now) return false;
  const daysLeft = Math.ceil((endMs - now) / DAY);
  if (daysLeft > EXPIRY_REMINDER_DAYS) return false;
  if (user.expiryEmailSent === end) return false; // already emailed for this period
  return true;
}

// Emails every user whose period is ending soon (exactly once per period).
// Never throws — failures are logged so one broken address can't block others.
async function sendExpiryReminders() {
  const store = db.get();
  const now = Date.now();
  const due = (store.users || []).filter((u) => expiryReminderNeeded(u, now));
  if (!due.length) return { emailed: 0, due: 0 };

  const { sendSubscriptionExpiring } = require("./email");
  const typeLabel = (u) => (userTypeOf(u) === "club" ? "خطة النادي 🏟️" : "خطة اللاعب 🎮");
  const fmt = (iso) => {
    try { return new Date(iso).toLocaleDateString("ar-EG"); } catch (e) { return iso || "—"; }
  };

  let emailed = 0;
  for (const u of due) {
    const end = u.subscriptionStatus === "active" && u.subscriptionExpiresAt
      ? u.subscriptionExpiresAt
      : u.trialEnd;
    const price = (u.price != null ? u.price : PRICES[userTypeOf(u)]);
    try {
      await sendSubscriptionExpiring(u.email, u.name, typeLabel(u), fmt(end), price);
      u.expiryEmailSent = end;
      emailed++;
    } catch (e) {
      console.error("[email] expiry reminder failed for " + u.email + ":", e.message);
    }
  }
  if (emailed) db.save();
  return { emailed, due: due.length };
}

module.exports = {
  userTypeOf,
  effectiveStatus,
  hasAccess,
  trialInfo,
  startTrial,
  activateSubscription,
  cancelSubscription,
  resumeSubscription,
  markPastDue,
  markExpired,
  refresh,
  refreshAll,
  collectTrialNotifications,
  collectExpiryNotifications,
  expireStalePending,
  notify,
  notifyAdmin,
  sendExpiryReminders,
  expiryReminderNeeded,
  PRICES,
  CURRENCY
};