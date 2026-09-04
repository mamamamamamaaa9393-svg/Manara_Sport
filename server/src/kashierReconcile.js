/* ==========================================================================
   Manara — Kashier payment reconciliation (self-healing).
   Webhooks can be lost (restarts, tunnels, network) — the user still pays
   on Kashier's side but our DB stays "pending_kashier" forever. This module
   asks Kashier directly about every pending session and activates the
   subscription when the payment actually succeeded. Triggered lazily from
   the subscription-status endpoint and before creating a new checkout
   session (so a retry never cancels an already-paid session).
   ========================================================================== */
const db = require("./db");
const kashier = require("./kashier");
const sub = require("./subscription");

const lastCheck = new Map(); // userId -> last reconcile timestamp
const MIN_INTERVAL = 5000; // avoid hammering Kashier during status polling

/* Check the user's pending Kashier sessions against Kashier's live status.
   Returns true if at least one pending payment was confirmed + activated. */
async function reconcilePendingKashier(user) {
  if (!user || !kashier.enabled()) return false;
  const now = Date.now();
  if (now - (lastCheck.get(user.id) || 0) < MIN_INTERVAL) return false;
  lastCheck.set(user.id, now);

  const store = db.get();
  const pendings = store.transactions.filter(
    (t) => t.userId === user.id && t.status === "pending_kashier" && t.sessionId
  );
  if (!pendings.length) return false;

  let activated = false;
  for (const tx of pendings) {
    let st;
    try {
      st = await kashier.getSessionStatus(tx.sessionId);
    } catch (e) {
      console.warn("[kashier] reconcile query failed " + tx.id + ":", e.message);
      continue;
    }
    if (!st.paid) continue; // still open/abandoned — leave pending

    tx.status = "approved";
    tx.reviewedAt = new Date().toISOString();
    tx.providerId = "kashier:" + tx.sessionId;
    tx.verification = {
      provider: "kashier",
      source: "reconcile",
      sessionId: tx.sessionId,
      checkedAt: new Date().toISOString()
    };

    const u = store.users.find((x) => x.id === tx.userId);
    if (u) {
      sub.activateSubscription(u, { providerId: "kashier:" + tx.sessionId });
      sub.notify(u, "✅ تم تفعيل اشتراكك", "تم تأكيد الدفع عبر كاشير — اشتراكك نشط لمدة 30 يوماً.");
    }
    activated = true;
    console.log("[kashier] reconciled paid session " + tx.sessionId + " -> activated " + tx.userId);
  }
  if (activated) db.save();
  return activated;
}

module.exports = { reconcilePendingKashier };