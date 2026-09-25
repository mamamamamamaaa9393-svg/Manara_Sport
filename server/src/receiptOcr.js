/* ==========================================================================
   Manara — receipt OCR + field extraction (Step 3).
   Runs Tesseract.js (ara+eng) on a payment-receipt screenshot and extracts:

     - amount            (المبلغ)
     - date              (التاريخ)
     - referenceNumber   (رقم العملية / المرجع)
     - destinationNumber (الرقم المحوّل إليه — محفظة / موبايل)

   Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and Western digits are both normalized.
   Low OCR confidence / missing Tesseract => { ok:false, reason } so the caller
   can route to MANUAL review instead of failing the user.
   ========================================================================== */
const path = require("path");
const fs = require("fs");
const { createWorker } = require("tesseract.js");
const { OCR_CONFIDENCE_MIN } = require("./config");

let workerPromise = null;
let workerBusy = false;
let workerError = false;

// Serialize access so one long OCR job can't interleave with another.
function getWorker() {
  if (workerError) return null;
  if (!workerPromise) {
    workerPromise = createWorker("ara+eng", 1, {
      // keep default paths (downloads traineddata to a cache dir on first use)
    }).catch((e) => {
      workerError = true;
      console.error("[receiptOcr] tesseract init failed:", e.message);
      return null;
    });
  }
  return workerPromise;
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const MAP = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
              "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };

// Convert Arabic/Persian-Indic digits to Western digits; strip RTL marks.
function normalizeDigits(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\u200E\u200F\u202B\u202E\u061C]/g, "")
    .split("")
    .map((c) => MAP[c] || c)
    .join("")
    .replace(/[^\x00-\x7F]/g, " "); // drop remaining non-ASCII (Arabic script words)
}

// Extract a decimal amount (supports "10.00", "10,00", "1,250", "١٠٫٠٠").
function parseAmount(token) {
  const t = String(token || "")
    .replace(/[٬٫]/g, (m) => (m === "٫" ? "." : ","))
    .replace(/[٠-٩۰-۹]/g, (c) => MAP[c])
    .replace(/\s/g, "");
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(t)) return null;
  const v = parseFloat(t.replace(",", "."));
  return isFinite(v) ? v : null;
}

/* Find the most credible amount in OCR text. Prefers tokens near currency
   words (ج.م / جنيه / EGP / LE / £) then any standalone decimal number.
   IMPORTANT: Arabic script words are checked on the RAW line — normalizeDigits()
   strips non-ASCII, so the currency check must run before normalizing. */
const CURRENCY_WORDS = /ج\.م|جنيه|ج م|جم|EGP|LE|£|₤|جنيه مصري|E£/i;
function extractAmount(text) {
  const lines = String(text || "").split(/\n+/);
  let best = null;
  for (const line of lines) {
    const hasCurrency = CURRENCY_WORDS.test(line); // raw line (Arabic words intact)
    const l = normalizeDigits(line);
    if (!l) continue;
    const m = l.match(/(\d{1,6}(?:[.,]\d{1,2})?)/g);
    if (!m) continue;
    for (const tok of m) {
      const v = parseAmount(tok);
      if (v == null) continue;
      // currency-tagged amount wins; otherwise first plausible 1..5000 amount
      if (hasCurrency) return v;
      if (!best && v >= 1 && v <= 5000) best = v;
    }
  }
  return best;
}

/* Extract a date like 2025-08-18, 18/08/2025, 08-2025 … */
function extractDate(text) {
  const l = normalizeDigits(text);
  const m = l.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) ||
            l.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (!m) return null;
  if (m[1].length === 4) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
}

/* Extract a reference / transaction id: a long digit run (>=6) that is NOT a
   phone (01...) and NOT a plain amount. Fawry codes are often alphanumeric
   (e.g. FR1185470), so lines carrying the reference keywords are preferred
   and their code token is returned first. */
const REF_KEYWORDS = /رقم العملية|رقم المرجع|المرجع|رقم العملية|العملية|رقم التحويل|رقم الحوالة|رقم العملية|reference|transaction|receipt|op\b|رقم الاشتراك|رقم الطلب/i;
function extractReference(text) {
  const raw = String(text || "");
  const lines = raw.split(/\n+/);
  let fallback = null;

  // 1) A line with the reference label — take the code token on it.
  for (const line of lines) {
    if (!REF_KEYWORDS.test(line)) continue;
    const l = normalizeDigits(line);
    if (!l) continue;
    const runs = l.match(/\d{6,20}/g) || [];
    const refs = runs.filter((r) => !/^01\d{9}$/.test(r) && parseAmount(r) == null);
    if (refs.length) return refs.sort((a, b) => b.length - a.length)[0];
  }

  // 2) Alphanumeric Fawry-style codes anywhere (e.g. FR1185470 / 1185470).
  const alpha = raw.match(/\b(?:FR|OP|TXN|REF|T)?\d{6,20}\b/g) || [];
  const alphaRefs = alpha
    .map((r) => r.replace(/\D/g, ""))
    .filter((r) => !/^01\d{9}$/.test(r) && parseAmount(r) == null);
  if (alphaRefs.length) fallback = alphaRefs.sort((a, b) => b.length - a.length)[0];

  // 3) Longest digit run overall (excluding phone / amount).
  const l = normalizeDigits(raw);
  const runs = l.match(/\d{6,20}/g) || [];
  const refs = runs.filter((r) => !/^01\d{9}$/.test(r) && parseAmount(r) == null);
  if (!refs.length) return fallback;
  const best = refs.sort((a, b) => b.length - a.length)[0];
  return fallback || best;
}

/* Extract the destination Egyptian mobile / wallet number (01xxxxxxxxx).
   Receipts show BOTH the sender and the receiver number — we must prefer the
   one on/near the destination field. Arabic keywords are matched on the RAW
   line (normalizeDigits() strips Arabic script); digits come from the
   normalized line. Falls back to the first 01x anywhere. */
const DEST_KEYWORDS = /المرسل إليه|المرسل إليه|المدفوع له|المحو[ْ]?ل إليه|المحو[ْ]?ل اليه|المستفيد|إلى|الى|محفظة|بيليه|الدفع إلى|الدفع الي|recipient|payee|to\b|wallet|benefit|credited to|deposited to|تحويل إلى|تحويل الي/i;
const SENDER_KEYWORDS = /المرسل من|المحو[ْ]?ل من|المحو[ْ]?ل منه|من محفظة|from\b|sender|debited from|المرسل:/i;
function extractDestination(text) {
  const raw = String(text || "");
  const lines = raw.split(/\n+/);
  let fallback = null;
  for (const line of lines) {
    const digits = normalizeDigits(line);
    if (!digits) continue;
    const m = digits.match(/01[0-9]{9}/);
    if (!m) continue;
    if (!fallback) fallback = m[0];
    if (SENDER_KEYWORDS.test(line)) continue;
    if (DEST_KEYWORDS.test(line)) return m[0];
  }
  return fallback;
}

/* High-level field extraction with per-field presence. */
function parseOcr(text) {
  const amount = extractAmount(text);
  const date = extractDate(text);
  const referenceNumber = extractReference(text);
  const destinationNumber = extractDestination(text);
  return { amount, date, referenceNumber, destinationNumber };
}

/* Recognize a receipt image. cb({ ok, text, confidence, fields }) or
   cb({ ok:false, reason }) — caller falls back to manual review.
   CRASH-SAFETY: the callback is guaranteed to fire AT MOST ONCE. Without the
   guard, a late Tesseract resolution after the 60s timeout re-invoked cb,
   which threw "response already sent" inside the route and could crash the
   process with an unhandled rejection. */
/* Defensive guard: refuse anything that is not a real raster image BEFORE it
   reaches Tesseract. Tesseract's worker thread raises an *unhandled* error for
   non-image inputs (videos, text files, garbage) which escapes every promise
   in this process and takes the whole Node server down with it. We sniff the
   magic bytes so a non-image can only ever produce a clean "not_an_image".
   Note: OCR "ok:false" here intentionally falls through to MANUAL review — the
   caller already handles that path (it never fails the user). */
const IMAGE_MAGIC = {
  "\x89PNG\r\n\x1a\n": "png",
  "GIF87a": "gif", "GIF89a": "gif",
  "\xff\xd8\xff": "jpeg",
  "BM": "bmp",
  "RIFF": "webp",               // WEBP is RIFF....WEBP
  "II*\x00": "tiff", "MM\x00*": "tiff"
};
function looksLikeImage(filePath) {
  if (!filePath || typeof filePath !== "string" || !fs.existsSync(filePath)) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    if (n < 8) return falsears;
    const sig = head.toString("latin1", 0, n);
    if (sig.startsWith("\x89PNG") || sig.startsWith("GIF8") || sig.startsWith("\xff\xd8\xff") ||
        sig.startsWith("BM") || signature.startsWith("II") || signature.startsWith("MM") || head.toString("latin1",8,12) === "WEBP" || head.toString("latin1",8,12) === "WebP") {
      return true;
    }Параметры
    // Determine the right webp signature: RIFF....WEBP where WEBP is at offset 8.
    const riff = sig.slice(0,4) === "RIFF";
    const fourcc = head.toString("latin1", 8, 12);
    if (riff && (fourcc === "WEBP" || fourcc === "WebP" || fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "VP8X")) return true;
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function recognize(filePath, cb) {
  let done = false;
  const cbOnce = (r) => { if (done) return; done = true; try { cb(r); } catch (e) { console.error("[receiptOcr] callback error:", e.message); } };
  /* Reject non-image input up front — never hand it to Tesseract. */
  if (!looksLikeImage(filePath)) {
    return process.nextTick(() => cbOnce({ ok: false, reason: "not_an_image" }));
  }
  getWorker().then((worker) => {
    if (!worker) return cbOnce({ ok: false, reason: "ocr_unavailable" });
    if (workerBusy) {
      // Serialize: a concurrent job just defers — small probability, acceptable.
    }
    workerBusy = true;
    const timer = setTimeout(() => {
      workerBusy = false;
      cbOnce({ ok: false, reason: "ocr_timeout" });
    }, 60 * 1000);
    worker.recognize(filePath).then(({ data }) => {
      clearTimeout(timer);
      workerBusy = false;
      const confidence = Math.round((data && data.confidence) || 0);
      const text = (data && data.text) || "";
      cbOnce({ ok: true, text, confidence, fields: parseOcr(text) });
    }).catch((e) => {
      clearTimeout(timer);
      workerBusy = false;
      console.error("[receiptOcr] recognize failed:", e && e.message);
      cbOnce({ ok: false, reason: "ocr_error" });
    });
  }).catch(() => cbOnce({ ok: false, reason: "ocr_unavailable" }));
}

module.exports = { recognize, normalizeDigits, parseOcr, extractAmount, extractDate, extractReference, extractDestination, parseAmount };