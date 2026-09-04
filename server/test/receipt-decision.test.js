/* Unit tests for the receipt decision engine (steps 1+2+resubmit rule). */
const path = require("path");
const decide = require(path.join(__dirname, "..", "src", "receiptDecide"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

function store() {
  return {
    transactions: [
      { id: "tx_1", userId: "uA", referenceNumber: "REF-XYZ-1", screenshotHash: "hash1", transactionScreenshot: "/uploads/a.png", status: "approved" },
      { id: "tx_2", userId: "uB", referenceNumber: "REF-DUP", screenshotHash: "hash9", transactionScreenshot: "/uploads/b.png", status: "pending" },
      { id: "tx_3", userId: "uC", referenceNumber: "REF-OLD-REJECTED", screenshotHash: "hash7", transactionScreenshot: "/uploads/c.png", status: "rejected" }
    ]
  };
}

const PLAN_GAMER = 10;

// helper: build tx
function tx(o) {
  return Object.assign({
    id: "tx_new", userId: "uMe", referenceNumber: "REF-NEW-1",
    transactionScreenshot: "/uploads/new.png", screenshotHash: "hashNew",
    status: "pending"
  }, o);
}

console.log("\n=== receiptDecide unit tests ===\n");

// --- Step 1: duplicate detection ---
let r = decide.decide({ store: store(), tx: tx({ referenceNumber: "REF-XYZ-1" }), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 90, fields: {} } });
ok("duplicate reference rejected", r.decision === "reject" && r.code === "duplicate", r);

r = decide.decide({ store: store(), tx: tx({ screenshotHash: "hash1" }), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 90, fields: {} } });
ok("duplicate screenshot hash rejected", r.decision === "reject" && r.code === "duplicate", r);

r = decide.decide({ store: store(), tx: tx({ transactionScreenshot: "/uploads/b.png" }), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 90, fields: {} } });
ok("duplicate screenshot url rejected", r.decision === "reject" && r.code === "duplicate", r);

// same reference as a REJECTED tx must be allowed (resubmit rule)
r = decide.decide({ store: store(), tx: tx({ referenceNumber: "REF-OLD-REJECTED" }), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 90, fields: {} } });
ok("rejected-history reference allowed (resubmit)", r.decision !== "reject", r);

// --- Step 1: amount match ---
r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 5, ocr: { ok: true, confidence: 90, fields: {} } });
ok("wrong amount rejected", r.decision === "reject" && r.code === "amount_mismatch", r);

r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 10.5, ocr: { ok: true, confidence: 90, fields: {} } });
ok("amount within 0.5 tolerance accepted path", r.decision !== "reject", r);

r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: NaN, ocr: { ok: true, confidence: 90, fields: {} } });
ok("missing amount -> manual", r.decision === "manual" && r.code === "amount_missing", r);

// --- OCR gates ---
r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: false, reason: "ocr_unavailable" } });
ok("no OCR -> manual (never auto-reject)", r.decision === "manual" && r.code === "ocr_unavailable", r);

r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 20, fields: {} } });
ok("low OCR confidence -> manual", r.decision === "manual" && r.code === "ocr_low_confidence", r);

r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 90, fields: { amount: 99 } } });
ok("OCR amount mismatch -> reject", r.decision === "reject" && r.code === "ocr_amount_mismatch", r);

// --- Step 2: destination is covered in receipt-destination.test.js (needs
// MANARA_WALLETS set before config loads). Here only the non-wallet paths.

// --- Step 3: full auto-approve (no wallets configured) ---
r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 95, fields: { amount: 10, referenceNumber: "REF-NEW-1", destinationNumber: "01033333333" } } });
ok("all strong signals agree -> approve", r.decision === "approve", r);

// same reference as typed + no wallet config
r = decide.decide({ store: store(), tx: tx(), planPrice: PLAN_GAMER, userAmount: 10, ocr: { ok: true, confidence: 95, fields: { amount: 10, date: "2026-08-18" } } });
ok("amount+confidence only -> approve", r.decision === "approve", r);

// case-insensitive ref compare
const dc = require(path.join(__dirname, "..", "src", "receiptDecide"));
ok("sameRef case-insensitive", dc.sameRef(" abc 123 ", "ABC123") === true);

console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===\n");
process.exit(failed ? 1 : 0);