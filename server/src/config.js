/* ==========================================================================
   Manara billing configuration.
   All values come from environment variables with sensible defaults so the
   project runs locally with zero setup. NEVER expose secrets to the client —
   the frontend receives only what /api/subscription/status returns.
   ========================================================================== */
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7); // fallback when a user type has no specific value
const TRIAL_DAYS_BY_TYPE = {
  club: Number(process.env.TRIAL_DAYS_CLUB || 7), // clubs: 7 free days
  gamer: Number(process.env.TRIAL_DAYS_GAMER || 2) // players: 2 free days
};
const GRACE_DAYS = Number(process.env.PAYMENT_GRACE_DAYS || 3); // renewal grace period
const EXPIRY_REMINDER_DAYS = Number(process.env.EXPIRY_REMINDER_DAYS || 3); // email reminder before period end
// Pending payment receipts older than this are auto-cancelled (stale queue).
const PENDING_EXPIRY_HOURS = Number(process.env.PENDING_EXPIRY_HOURS || 72);
const BILLING_DAYS = 30; // monthly subscription period (in days)
const PRICES = {
  gamer: Number(process.env.PRICE_GAMER || 39),
  club: Number(process.env.PRICE_CLUB || 299)
};
const CURRENCY = process.env.CURRENCY || "EGP";
// Provider webhook secret (HMAC-SHA256). Empty = webhooks disabled.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

/* ---- Auto-verification of payment receipts (OCR + matching) ----
   MANARA_WALLETS  : comma-separated Egyptian mobile/wallet numbers that belong
                     to Manara. The OCR-extracted destination number on a
                     receipt must match one of these (Step 2). Empty = the
                     destination check is skipped (manual review decides).
   AMOUNT_TOLERANCE: allowed difference (EGP) between OCR/user amount and the
                     expected plan price (Step 1).
   OCR_CONFIDENCE_MIN: below this tesseract confidence -> route to manual.
   OCR_ENABLED     : set to "false" to disable OCR and always review manually.
*/
const MANARA_WALLETS = String(process.env.MANARA_WALLETS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const AMOUNT_TOLERANCE = Number(process.env.AMOUNT_TOLERANCE || 0.5);
const OCR_CONFIDENCE_MIN = Number(process.env.OCR_CONFIDENCE_MIN || 40);
const OCR_ENABLED = String(process.env.OCR_ENABLED || "true").toLowerCase() !== "false";
/* REVENUE SAFETY: while a receipt is pending review the user previously kept
   full premium access — an abuser could loop fabricated receipts (submit ->
   72h access -> stale-cancel -> resubmit) for infinite free premium.
   Default is now SECURE: access resumes only after approval. Set
   PENDING_GRANTS_ACCESS=true to restore the old lenient behaviour. */
const PENDING_GRANTS_ACCESS = String(process.env.PENDING_GRANTS_ACCESS || "false").toLowerCase() === "true";
/* Receipt auto-approval trusts pixels, not bank ledgers — a rendered fake can
   satisfy OCR. Default is now MANUAL review for every receipt; set
   RECEIPT_AUTO_APPROVE=true to re-enable OCR auto-approval. */
const RECEIPT_AUTO_APPROVE = String(process.env.RECEIPT_AUTO_APPROVE || "false").toLowerCase() === "true";

module.exports = {
  TRIAL_DAYS,
  TRIAL_DAYS_BY_TYPE,
  GRACE_DAYS,
  EXPIRY_REMINDER_DAYS,
  PENDING_EXPIRY_HOURS,
  BILLING_DAYS,
  PRICES,
  CURRENCY,
  WEBHOOK_SECRET,
  MANARA_WALLETS,
  AMOUNT_TOLERANCE,
  OCR_CONFIDENCE_MIN,
  OCR_ENABLED,
  PENDING_GRANTS_ACCESS,
  RECEIPT_AUTO_APPROVE
};