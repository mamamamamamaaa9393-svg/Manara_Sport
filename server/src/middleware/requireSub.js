/* Central paywall gate.
   Used by every "use your account" action (posting / editing a profile,
   uploading media, reviews, shortlists, scout notes, ...). When the free
   trial has ended and there is no active paid subscription, the request is
   rejected with 402 Payment Required so the client can route the user to the
   paywall. Public browsing, authentication and the payment endpoints
   themselves MUST stay un-gated so a lapsed user can still subscribe. */
const db = require("../db");
const sub = require("../subscription");

function requireActiveSub(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  const user = db.get().users.find((u) => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  // Lazily apply trial/expiry transitions so a just-ended trial is enforced
  // even between the periodic refresh sweeps.
  try {
    if (sub.refresh(user)) db.save();
  } catch (e) { /* non-fatal: enforcement still uses current state */ }
  if (sub.hasAccess(user)) return next();
  return res.status(402).json({
    error: "انتهت تجربتك المجانية — يرجى الاشتراك لاستخدام حسابك.",
    code: "SUBSCRIPTION_REQUIRED",
    requiresPayment: true
  });
}

module.exports = requireActiveSub;
