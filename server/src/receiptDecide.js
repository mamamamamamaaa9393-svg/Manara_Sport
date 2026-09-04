/* ==========================================================================
   Manara — payment-receipt decision engine (Steps 1 + 2 + resubmit rule).
   Combines the user-entered data (amount + reference) with the OCR-extracted
   fields and prior transaction history into ONE decision:

     "approve"  -> auto-activate the subscription (all strong signals agree)
     "manual"   -> cannot decide reliably -> leave for admin review
     "reject"   -> clear mismatch / duplicate -> refuse, user may resubmit
                   with corrected data (NEVER a permanent lock)

   Decision rules (in priority order):
     1. Duplicate detection (Step 1): same reference number or same screenshot
        already used on an APPROVED or PENDING transaction by ANY user.
        -> reject (reusing a receipt = fraud signal).
     2. Amount match (Step 1): user-entered amount must equal the plan price
        within AMOUNT_TOLERANCE. OCR amount must also match (if available).
        -> mismatch = reject (wrong amount paid).
     3. Destination account (Step 2): if MANARA_WALLETS is configured, the
        OCR destination must be one of Manara's wallet numbers.
        -> mismatch = reject (money went to the wrong account).
     4. OCR confidence gating: if OCR is enabled but low-confidence / missing,
        route to manual — never auto-approve on shaky OCR.
   ========================================================================== */
const config = require("./config");
const { PRICES, MANARA_WALLETS, AMOUNT_TOLERANCE, OCR_CONFIDENCE_MIN, OCR_ENABLED } = require("./config");

function eqAmount(a, b, tol) {
  return a != null && b != null && Math.abs(a - b) <= (tol != null ? tol : AMOUNT_TOLERANCE);
}

/* Compare a normalized reference string. Case/trim-insensitive. */
function sameRef(a, b) {
  return String(a || "").replace(/\s+/g, "").toLowerCase() ===
         String(b || "").replace(/\s+/g, "").toLowerCase();
}

/* Does the receipt screenshot (file hash / url) appear in earlier history?
   APPROVED and PENDING always count. REJECTED/CANCELLED count too once their
   24-hour correction window has passed — that keeps the "fix a typo and
   resubmit quickly" flow open while closing the abuse loop of re-cycling one
   fabricated receipt through stale-cancel -> resubmit forever. */
const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
function findDuplicate(store, tx, excludeId) {
  const now = Date.now();
  const list = store.transactions.filter((t) => {
    if (!t || t.id === excludeId) return false;
    if (t.status === "approved" || t.status === "pending") return true;
    if (t.status === "rejected" || t.status === "cancelled") {
      const at = t.reviewedAt
        ? new Date(t.reviewedAt).getTime()
        : new Date(t.createdAt || 0).getTime();
      return !(now - at < CORRECTION_WINDOW_MS);
    }
    return false;
  });
  for (const t of list) {
    if (tx.referenceNumber && t.referenceNumber && sameRef(t.referenceNumber, tx.referenceNumber)) {
      return { type: "reference", otherTxId: t.id, otherStatus: t.status };
    }
    if (tx.screenshotHash && t.screenshotHash && t.screenshotHash === tx.screenshotHash) {
      return { type: "screenshot", otherTxId: t.id, otherStatus: t.status };
    }
    if (tx.transactionScreenshot && t.transactionScreenshot && tx.transactionScreenshot === t.transactionScreenshot) {
      return { type: "screenshot_url", otherTxId: t.id, otherStatus: t.status };
    }
  }
  return null;
}

/* The one decision function used by submit-payment.
   Args:
     { store, tx, planPrice, userAmount, ocr }
     tx   = the transaction being evaluated (id/userId/referenceNumber/…)
     userAmount = numeric amount the user typed
     ocr  = { ok:false, reason }  OR  { ok:true, confidence, fields:{ amount, date, referenceNumber, destinationNumber } }
   Returns { decision:"approve"|"manual"|"reject", code, message, ocr, duplicate }
*/
function decide({ store, tx, planPrice, userAmount, ocr }) {
  // ---- Step 1a: duplicate detection (before anything else).
  const dup = findDuplicate(store, tx, tx.id);
  if (dup) {
    return {
      decision: "reject",
      code: "duplicate",
      message: "❌ هذا الإيصال أو رقم العملية مستخدم من قبل — إعادة استخدام إيصال/رقم عملية سابق غير مسموحة. أعد رفع إيصال جديد للعملية الحالية.",
      duplicate: dup
    };
  }

  // ---- Step 1b: amount must match the plan price.
  if (userAmount == null || !isFinite(userAmount)) {
    return { decision: "manual", code: "amount_missing", message: "يرجى إدخال المبلغ المدفوع حتى نتمكن من التحقق." };
  }
  if (!eqAmount(userAmount, planPrice)) {
    return {
      decision: "reject",
      code: "amount_mismatch",
      message: "❌ المبلغ المُدخل (" + userAmount + " ج.م) لا يطابق سعر الخطط (" + planPrice + " ج.م) — تحقق من المبلغ وأعد الإرسال."
    };
  }

  // ---- OCR result gates.
  const ocrEnabled = OCR_ENABLED;
  if (!ocrEnabled || !ocr || !ocr.ok) {
    // No OCR available -> cannot auto-verify -> manual review (never auto-reject).
    return { decision: "manual", code: "ocr_unavailable", message: "طلب الدفع مُرسل — بانتظار مراجعة الإدارة.", ocr };
  }

  const fields = ocr.fields || {};
  const conf = ocr.confidence || 0;

  // Low confidence: the OCR is not reliable -> manual review.
  if (conf < OCR_CONFIDENCE_MIN) {
    return { decision: "manual", code: "ocr_low_confidence", message: "طلب الدفع مُرسل — بانتظار مراجعة الإدارة.", ocr };
  }

  // ---- Step 1c: OCR amount must agree with the plan price (if OCR read one).
  if (fields.amount != null && !eqAmount(fields.amount, planPrice)) {
    return {
      decision: "reject",
      code: "ocr_amount_mismatch",
      message: "❌ المبلغ المكتشف في الإيصال (" + fields.amount + " ج.م) لا يطابق سعر الخطة (" + planPrice + " ج.م). أعد رفع إيصال العملية الصحيح.",
      ocr
    };
  }

  // ---- Step 2: destination account must be one of Manara's wallets.
  if (MANARA_WALLETS.length && fields.destinationNumber) {
    if (MANARA_WALLETS.indexOf(fields.destinationNumber) === -1) {
      return {
        decision: "reject",
        code: "destination_mismatch",
        message: "❌ الرقم المحوَّل إليه في الإيصال لا يطابق محفظة منارة الرسمية. تأكد من رقم المحفظة وأعد الرفع.",
        ocr
      };
    }
  } else if (MANARA_WALLETS.length && !fields.destinationNumber) {
    // Wallet configured but OCR couldn't read the destination -> manual.
    return { decision: "manual", code: "ocr_no_destination", message: "طلب الدفع مُرسل — بانتظار مراجعة الإدارة.", ocr };
  }

  // ---- Step 3 final: strong signals all agree -> auto-approve.
  // REVENUE SAFETY: OCR reads pixels, not bank ledgers — a rendered fake can
  // satisfy every check above. Auto-approval is therefore OFF by default
  // (RECEIPT_AUTO_APPROVE=true in .env re-enables it); receipts fall through
  // to manual admin review.
  if (!config.RECEIPT_AUTO_APPROVE) {
    return { decision: "manual", code: "auto_approve_disabled", message: "طلب الدفع مُرسل — بانتظار مراجعة الإدارة.", ocr };
  }
  return { decision: "approve", code: "auto", message: "تم التحقق من الإيصال تلقائياً ✅", ocr };
}

module.exports = { decide, eqAmount, sameRef, findDuplicate };