/* ==========================================================================
   Payment-provider webhook endpoint.
   The provider (e.g. Stripe / Paymob / Fawry Gateway) POSTs signed events
   here; it is the verified source of truth for subscription status. Rules:
     - HMAC-SHA256 signature verified with config.WEBHOOK_SECRET.
     - Idempotent: each event id is processed exactly once.
     - Only "invoice.paid" activates/renews; failures -> past_due/expired.
   Mounted with express.raw() BEFORE the JSON body parser so the raw payload
   can be signed/verified. When WEBHOOK_SECRET is empty the endpoint is
   disabled (503) — the manual admin verification path remains the active
   payment mechanism in that case.
   ========================================================================== */
const router = require("express").Router();
const crypto = require("crypto");
const db = require("../db");
const sub = require("../subscription");
const { WEBHOOK_SECRET } = require("../config");

function eventUser(evt) {
  const store = db.get();
  const customer = evt.customer || {};
  const id = customer.id || evt.customerId || evt.userId;
  const email = (customer.email || evt.email || "").toString().toLowerCase().trim();
  if (id) {
    const u = store.users.find((x) => x.providerCustomerId === id || x.id === id);
    if (u) return u;
  }
  if (email) {
    const u = store.users.find((x) => x.email === email);
    if (u) return u;
  }
  return null;
}

router.post("/", (req, res) => {
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Webhooks not configured (WEBHOOK_SECRET is empty)" });
  }
  const raw = req.body; // Buffer from express.raw()
  const sig = String(req.get("x-webhook-signature") || "");
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const a = Buffer.from(String(sig), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let evt;
  try {
    evt = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }
  const id = String(evt.id || evt.event_id || "");
  if (!id) return res.status(400).json({ error: "Missing event id" });

  const store = db.get();
  if ((store.webhooks || []).some((w) => w.id === id)) {
    return res.json({ received: true, duplicate: true });
  }
  store.webhooks = store.webhooks || [];
  store.webhooks.push({ id, type: evt.type || "unknown", receivedAt: new Date().toISOString() });
  // Cap the audit log — otherwise it grows unbounded forever (memory + Mongo).
  const MAX_WEBHOOK_LOG = 500;
  if (store.webhooks.length > MAX_WEBHOOK_LOG) {
    store.webhooks = store.webhooks.slice(-MAX_WEBHOOK_LOG);
  }

  const user = eventUser(evt);
  const periodEnd = evt.periodEnd || (evt.data && evt.data.periodEnd) || null;
  const providerId = evt.subscriptionId || (evt.data && evt.data.subscriptionId) || null;
  const customerId = (evt.customer && evt.customer.id) || null;

  switch (evt.type) {
    case "invoice.paid":
    case "subscription.renewed":
    case "subscription.created":
      if (user) {
        sub.activateSubscription(user, {
          from: periodEnd || null,
          plan: (evt.data && evt.data.plan) || sub.userTypeOf(user),
          providerId,
          providerCustomerId: customerId
        });
      }
      break;
    case "invoice.payment_failed":
      if (user) sub.markPastDue(user);
      break;
    case "subscription.cancelled":
      if (user) sub.cancelSubscription(user);
      break;
    case "subscription.deleted":
    case "subscription.trial_ended":
      if (user) sub.markExpired(user);
      break;
    default:
      // Unknown event: acknowledge, do nothing.
      break;
  }

  db.save();
  return res.json({ received: true });
});

module.exports = router;