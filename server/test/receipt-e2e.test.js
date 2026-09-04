/* Live E2E test of the payment-receipt auto-verification pipeline (steps 1-3).
   Runs against the LIVE server on localhost:5000.
   Requires the server to be running and the receipt PNGs generated in
   C:\Users\pc1\AppData\Local\Temp\opencode\.

   Flow:
     1. Admin login
     2. Register player (verified) -> admin approve -> 7-day trial
     3. Upload receipt_good.png via /api/upload (purpose=payment_receipt)
     4. Submit payment amount=39 ref=9988776655 -> OCR(95) reads amount=39,
        ref=9988776655, destination=01229409393 (matches MANARA_WALLETS)
        -> expect AUTO-APPROVE, subscription active
     5. Amount mismatch (amount=5) -> AUTO-REJECT, resubmitAllowed=true
     6. Duplicate reference reuse -> AUTO-REJECT code=duplicate
     7. Submit with correct data after a reject -> allowed (no permanent lock)
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = "http://localhost:5000";
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";
const TEST_EMAIL = "test_ocr_" + Date.now() + "@test.com";
const TEST_PASS = "TestPass123!";
const TMP = "C:\\Users\\pc1\\AppData\\Local\\Temp\\opencode";

const { otpFrom } = require("./helpers");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 5000, path: p,
      headers: { "Content-Type": "application/json", "Accept": "application/json" }
    };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, data: j, raw: d });
      });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

// multipart upload with a PNG file
function upload(filePath, purpose, token) {
  return new Promise((resolve, reject) => {
    const b = fs.readFileSync(filePath);
    const boundary = "----manara" + crypto.randomBytes(8).toString("hex");
    const parts = [];
    const addField = (n, v) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
    };
    addField("purpose", purpose);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([Buffer.concat(parts), head, b, tail]);
    const opts = {
      method: "POST", hostname: "localhost", port: 5000, path: "/api/upload",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Accept": "application/json" }
    };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, raw: d }); });
    });
    r.on("error", reject); r.end(body);
  });
}

function db() { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8")); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  console.log("\n=== Receipt auto-verification E2E test ===");

  // ---- 1. admin login
  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  ok("admin login", adminLogin.status === 200 && adminLogin.data && adminLogin.data.token, adminLogin);
  const adminToken = adminLogin.data.token;

  // ---- 2. register + verify + approve (matching auth.routes flow)
  const sv = await req("POST", "/api/auth/send-verification", { email: TEST_EMAIL });
  ok("send-verification", sv.status === 200 && sv.data && sv.data.verificationId, sv);
  const vId = sv.data && sv.data.verificationId;
  const code = otpFrom(sv);
  ok("OTP generated in store", !!code);
  const ve = await req("POST", "/api/auth/verify-email", { verificationId: vId, code });
  ok("verify-email", ve.status === 200, ve);

  const reg = await req("POST", "/api/auth/register", {
    role: "player",
    data: {
      full_name: "OCR Test Player",
      email: TEST_EMAIL,
      password: TEST_PASS,
      password_confirm: TEST_PASS,
      sport: "Football",
      position: "Striker (ST)",
      documents: { birth_cert: "/uploads/test_birth.jpg", medical: "/uploads/test_medical.jpg", declaration: "/uploads/test_decl.jpg" },
      videos: [{ url: "/uploads/test_v.mp4" }]
    }
  });
  ok("register -> pending", reg.status === 201 && reg.data && reg.data.status === "pending", reg);
  const regId = reg.data && reg.data.registrationId;

  const approve = await req("POST", "/api/admin/registrations/" + regId + "/approve", {}, adminToken);
  ok("admin approves registration", approve.status === 200, approve);
  const afterApproval = db();
  const userRec = afterApproval.users.find((x) => x.email === TEST_EMAIL);
  ok("user approved + trial", userRec && userRec.approved === true && !!userRec.trialStart, userRec);

  // ---- 3. player login + status
  const login = await req("POST", "/api/auth/login", { email: TEST_EMAIL, password: TEST_PASS });
  ok("player login", login.status === 200 && login.data && login.data.token, login);
  const token = login.data.token;

  const st = await req("GET", "/api/subscription/status", null, token);
  ok("status trialing", st.status === 200 && st.data && st.data.status === "trialing", st.data);

  // ---- 4. upload GOOD receipt
  const up = await upload(path.join(TMP, "receipt_good.png"), "payment_receipt", token);
  ok("receipt upload accepted", up.status === 201 && up.data && up.data.files && up.data.files.length, up);
  const screenshotUrl = up.data.files[0].url;

  // ---- 5. submit payment -> AUTO-APPROVE (amount 39, OCR reads everything)
  const pay = await req("POST", "/api/subscription/submit-payment", {
    method: "vodafone_cash", referenceNumber: "9988776655", screenshotUrl: screenshotUrl, amount: 39
  }, token);
  ok("submit-payment with amount", pay.status === 201, pay);
  ok("AUTO-APPROVED (good receipt)", pay.data && pay.data.autoApproved === true, pay.data);
  if (pay.data && pay.data.transaction) {
    ok("verification recorded", !!pay.data.transaction.verification, pay.data.transaction.verification);
    ok("verification code auto", pay.data.transaction.verification.code === "auto", pay.data.transaction.verification);
    ok("OCR fields extracted", pay.data.transaction.verification.ocrFields &&
       pay.data.transaction.verification.ocrFields.amount === 39 &&
       pay.data.transaction.verification.ocrFields.destinationNumber === "01229409393", pay.data.transaction.verification.ocrFields);
  }

  // subscription now ACTIVE
  const st2 = await req("GET", "/api/subscription/status", null, token);
  ok("subscription active after auto-approve", st2.data && st2.data.status === "active", st2.data);

  // ---- 6. amount mismatch -> AUTO-REJECT + resubmitAllowed
  const up2 = await upload(path.join(TMP, "receipt_wrong_amount.png"), "payment_receipt", token);
  ok("wrong-amount receipt upload accepted", up2.status === 201 && up2.data && up2.data.files, up2);
  const pay2 = await req("POST", "/api/subscription/submit-payment", {
    method: "fawry", referenceNumber: "1122334455", screenshotUrl: up2.data.files[0].url, amount: 5
  }, token);
  ok("amount mismatch submit returns 201", pay2.status === 201, pay2);
  ok("AUTO-REJECTED + resubmit allowed", pay2.data && pay2.data.autoRejected === true && pay2.data.resubmitAllowed === true, pay2.data);
  if (pay2.data && pay2.data.transaction) {
    ok("reject code amount_mismatch", pay2.data.transaction.verification.code === "amount_mismatch", pay2.data.transaction.verification);
  }

  // ---- 7. duplicate reference -> AUTO-REJECT (tx_approved has 9988776655)
  const up3 = await upload(path.join(TMP, "receipt_good.png"), "payment_receipt", token);
  ok("duplicate receipt upload accepted", up3.status === 201 && up3.data && up3.data.files, up3);
  const pay3 = await req("POST", "/api/subscription/submit-payment", {
    method: "fawry", referenceNumber: "9988776655", screenshotUrl: up3.data.files[0].url, amount: 39
  }, token);
  ok("duplicate submit returns 201", pay3.status === 201, pay3);
  ok("DUPLICATE rejected", pay3.data && pay3.data.autoRejected === true && pay3.data.transaction.verification.code === "duplicate", pay3.data);

  // ---- 8. after reject, resubmit with fresh reference + fresh file -> allowed
  const up4 = await upload(path.join(TMP, "receipt_resubmit.png"), "payment_receipt", token);
  ok("resubmit file upload accepted", up4.status === 201 && up4.data && up4.data.files, up4);
  const pay4 = await req("POST", "/api/subscription/submit-payment", {
    method: "fawry", referenceNumber: "5544332211", screenshotUrl: up4.data.files[0].url, amount: 39
  }, token);
  ok("resubmit after reject NOT blocked", pay4.status === 201, pay4);
  ok("resubmit result is decision (manual or approve, not duplicate)", pay4.data && !(pay4.data.autoRejected === true && pay4.data.transaction.verification.code === "duplicate"), pay4.data);

  console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });