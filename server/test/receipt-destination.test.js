/* Destination-account (Step 2) tests — runs with MANARA_WALLETS pre-set so
   config loads with the wallets at require-time. */
process.env.MANARA_WALLETS = "01000000000,01011111111";
const path = require("path");
const decide = require(path.join(__dirname, "..", "src", "receiptDecide"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

const store = () => ({ transactions: [] });
const tx = () => ({ id: "tx_new", userId: "uMe", referenceNumber: "REF-NEW-1", transactionScreenshot: "/uploads/new.png", screenshotHash: "h", status: "pending" });

let r = decide.decide({ store: store(), tx: tx(), planPrice: 10, userAmount: 10, ocr: { ok: true, confidence: 90, fields: { destinationNumber: "01022222222" } } });
ok("destination mismatch -> reject", r.decision === "reject" && r.code === "destination_mismatch", r);

r = decide.decide({ store: store(), tx: tx(), planPrice: 10, userAmount: 10, ocr: { ok: true, confidence: 90, fields: { destinationNumber: "01000000000" } } });
ok("destination match -> auto-approve", r.decision === "approve", r);

r = decide.decide({ store: store(), tx: tx(), planPrice: 10, userAmount: 10, ocr: { ok: true, confidence: 90, fields: { amount: 10 } } });
ok("wallets configured but OCR no destination -> manual", r.decision === "manual" && r.code === "ocr_no_destination", r);

console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===\n");
process.exit(failed ? 1 : 0);