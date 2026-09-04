/* Manara subscription system end-to-end test.
   Runs against the LIVE server on localhost:5000.
   Uses real API calls + direct db inspection for assertions.

   Flow tested:
     1. Login as admin
     2. Register a test player (email verified, docs present) -> pending
     3. Admin approves -> 7-day trial starts
     4. Player logs in, checks /api/subscription/status -> trialing, daysLeft<=7
     5. Submit payment with vodafone_cash + screenshot -> pending tx
     6. Submit payment with instapay -> MUST be rejected (removed method)
     7. Admin approves payment -> subscription active for ~30 days
     8. Reject path: new tx -> reject -> user stays inactive
     9. Payment receipt filter: edited image upload must be rejected
    10. Expiry reminder logic (unit-style via sub.expiryReminderNeeded)
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:5000";
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";
const TEST_EMAIL = "test_sub_" + Date.now() + "@test.com";
const TEST_PASS = "TestPass123!";

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
      method,
      hostname: "localhost",
      port: 5000,
      path: p,
      headers: { "Content-Type": "application/json", "Accept": "application/json" }
    };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, data: j, raw: d });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function db() { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8")); }

async function run() {
  console.log("\n=== Manara subscription system E2E test ===");

  // ---- 1. admin login
  console.log("\n[1] Admin login");
  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  ok("admin login returns token", adminLogin.status === 200 && adminLogin.data && adminLogin.data.token, adminLogin);
  const adminToken = adminLogin.data.token;
  const adminId = adminLogin.data.user.id;

  // ---- 2. register test player (verify email first)
  console.log("\n[2] Register test player");
  const sv = await req("POST", "/api/auth/send-verification", { email: TEST_EMAIL });
  ok("send-verification", sv.status === 200 && sv.data.verificationId, sv);
  const vId = sv.data.verificationId;
  // OTP comes from the dev response (works with SMTP on/off, JSON or Mongo)
  const code = otpFrom(sv);
  ok("OTP generated in store", !!code);
  const ve = await req("POST", "/api/auth/verify-email", { verificationId: vId, code });
  ok("verify-email", ve.status === 200, ve);

  const docs = {
    birth_cert: "/uploads/test_birth.jpg",
    medical: "/uploads/test_medical.jpg",
    declaration: "/uploads/test_decl.jpg"
  };
  const reg = await req("POST", "/api/auth/register", {
    role: "player",
    data: {
      full_name: "Test Sub Player",
      email: TEST_EMAIL,
      password: TEST_PASS,
      password_confirm: TEST_PASS,
      sport: "Football",
      position: "Striker (ST)",
      documents: docs,
      videos: [{ url: "/uploads/test_v.mp4" }]
    }
  });
  ok("register -> pending", reg.status === 201 && reg.data.status === "pending", reg);

  // ---- 3. admin approves
  console.log("\n[3] Admin approves registration -> trial starts");
  const regId = reg.data.registrationId;
  const approve = await req("POST", "/api/admin/registrations/" + regId + "/approve", {}, adminToken);
  ok("approve registration", approve.status === 200, approve);
  let d = db();
  const user = d.users.find((u) => u.email === TEST_EMAIL);
  ok("user approved", user && user.approved === true);
  ok("trial started (trialStart set)", user && !!user.trialStart);
  const trialDays = user && user.trialEnd ? Math.round((new Date(user.trialEnd) - new Date(user.trialStart)) / 86400000) : null;
  const { TRIAL_DAYS_BY_TYPE } = require("../src/config");
  ok("trial = config days for gamer", trialDays === TRIAL_DAYS_BY_TYPE.gamer, { trialDays, expected: TRIAL_DAYS_BY_TYPE.gamer });

  // ---- 4. player login + status
  console.log("\n[4] Player login + subscription status");
  const pl = await req("POST", "/api/auth/login", { email: TEST_EMAIL, password: TEST_PASS });
  ok("player login", pl.status === 200 && pl.data.token, pl);
  const playerToken = pl.data.token;
  const st = await req("GET", "/api/subscription/status", null, playerToken);
  ok("status endpoint 200", st.status === 200, st);
  ok("status = trialing", st.data.status === "trialing", st.data.status);
  ok("trial.daysLeft <= 7", st.data.trial && st.data.trial.daysLeft <= 7, st.data.trial);
  ok("hasAccess true during trial", st.data.active === true);

  // ---- 5. submit payment (vodafone_cash)
  console.log("\n[5] Submit payment (Vodafone Cash)");
  const pay = await req("POST", "/api/subscription/submit-payment", {
    method: "vodafone_cash",
    referenceNumber: "01012345678",
    screenshotUrl: "/uploads/pay_test.jpg",
    amount: 39
  }, playerToken);
  ok("submit-payment accepted", pay.status === 201 && pay.data.transaction, pay);
  const txId = pay.data.transaction.id;
  ok("tx pending", pay.data.transaction.status === "pending");

  // ---- 6. instapay / card must be rejected
  console.log("\n[6] Removed methods rejected");
  const badInsta = await req("POST", "/api/subscription/submit-payment", {
    method: "instapay", referenceNumber: "x", screenshotUrl: "/uploads/y.jpg"
  }, playerToken);
  ok("instapay rejected (400)", badInsta.status === 400, badInsta);
  const badCard = await req("POST", "/api/subscription/submit-payment", {
    method: "card", referenceNumber: "x", screenshotUrl: "/uploads/y.jpg"
  }, playerToken);
  ok("card rejected (400)", badCard.status === 400, badCard);
  // while pending, a second submit is blocked (409)
  const dup = await req("POST", "/api/subscription/submit-payment", {
    method: "fawry", referenceNumber: "2", screenshotUrl: "/uploads/z.jpg", amount: 39
  }, playerToken);
  ok("duplicate pending blocked (409)", dup.status === 409, dup);

  // ---- 7. admin approves payment
  console.log("\n[7] Admin approves payment -> active");
  const ap = await req("POST", "/api/admin/transactions/" + txId + "/approve", {}, adminToken);
  ok("approve tx", ap.status === 200, ap);
  const st2 = await req("GET", "/api/subscription/status", null, playerToken);
  ok("status = active after approval", st2.data.status === "active", st2.data.status);
  const periodDays = st2.data.subscription
    ? Math.round((new Date(st2.data.subscription.periodEnd) - new Date(st2.data.subscription.periodStart)) / 86400000)
    : null;
  ok("billing period ~30 days", periodDays === 30 || periodDays === 31, { periodDays });

  // ---- 8. reject path
  console.log("\n[8] Payment reject path");
  const pay2 = await req("POST", "/api/subscription/submit-payment", {
    method: "fawry", referenceNumber: "ref2", screenshotUrl: "/uploads/pay2.jpg", amount: 39
  }, playerToken);
  ok("second payment submitted", pay2.status === 201, pay2);
  const tx2 = pay2.data.transaction.id;
  const rej = await req("POST", "/api/admin/transactions/" + tx2 + "/reject", { note: "إيصال غير صحيح" }, adminToken);
  ok("reject tx", rej.status === 200, rej);
  ok("tx marked rejected", db().transactions.find((t) => t.id === tx2).status === "rejected");

  // ---- 9. payment receipt filter (unit test on the validator)
  console.log("\n[9] Receipt forensics");
  const rv = require(path.join(__dirname, "..", "src", "receiptValidate"));
  const zlib = require("zlib");
  // build a REAL valid PNG (genuine decodable image, screenshot-like ~100KB)
  function makePng(w, h) {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const raw = Buffer.alloc(h * (1 + w * 3)); // filter byte + RGB rows
    for (let y = 0; y < h; y++) {
      const off = y * (1 + w * 3);
      raw[off] = 0; // no filter
      for (let x = 0; x < w; x++) {
        const o = off + 1 + x * 3;
        const v = Math.floor(rnd() * 256);
        raw[o] = v; raw[o + 1] = Math.floor(rnd() * 256); raw[o + 2] = Math.floor(rnd() * 256);
      }
    }
    const chunk = (type, data) => {
      const t = Buffer.from(type, "latin1");
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
      return Buffer.concat([len, t, data, crc]);
    };
    // crc32 (PNG uses IEEE)
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    function crc32(buf) {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, color type RGB
    const idat = zlib.deflateSync(raw);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0))
    ]);
  }
  const cleanPng = path.join(__dirname, "..", "uploads", "test_clean.png");
  const editedPng = path.join(__dirname, "..", "uploads", "test_edited.png");
  const cleanBuf = makePng(720, 720);
  fs.writeFileSync(cleanPng, cleanBuf);
  fs.writeFileSync(editedPng, Buffer.concat([cleanBuf, Buffer.from("tEXtSoftwarePhotoshop", "latin1")]));
  await new Promise((res) => rv.validateReceipt(cleanPng, (vr) => {
    ok("clean 400x400 PNG passes", vr.ok === true, vr);
    res();
  }));
  await new Promise((res) => rv.validateReceipt(editedPng, (vr) => {
    ok("edited PNG rejected", vr.ok === false && vr.code === "edited", vr);
    res();
  }));
  // non-image (>4KB so it passes the size gate and hits the format gate)
  const txt = path.join(__dirname, "..", "uploads", "test_fake.txt");
  fs.writeFileSync(txt, "MZ" + "x".repeat(9000));
  await new Promise((res) => rv.validateReceipt(txt, (vr) => {
    ok("non-image rejected", vr.ok === false && vr.code === "not_image", vr);
    res();
  }));
  // cleanup
  [cleanPng, editedPng, txt].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });

  // ---- 10. expiry reminder logic
  console.log("\n[10] Expiry reminder logic");
  const sub = require(path.join(__dirname, "..", "src", "subscription"));
  const near = Object.assign({}, user, { subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 2 * 86400000).toISOString() });
  ok("reminder needed when 2 days left", sub.expiryReminderNeeded(near, Date.now()) === true);
  const far = Object.assign({}, user, { subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 20 * 86400000).toISOString() });
  ok("no reminder when 20 days left", sub.expiryReminderNeeded(far, Date.now()) === false);
  const sent = Object.assign({}, near, { expiryEmailSent: near.subscriptionExpiresAt });
  ok("no duplicate reminder for same period", sub.expiryReminderNeeded(sent, Date.now()) === false);

  // ---- cleanup test user (keep db tidy)
  console.log("\n[cleanup] Remove test user + transactions");
  const store = db();
  store.users = store.users.filter((u) => u.email !== TEST_EMAIL);
  store.players = store.players.filter((p) => p.userId !== user.id);
  store.registrations = store.registrations.filter((r) => r.email !== TEST_EMAIL);
  store.verifications = (store.verifications || []).filter((v) => v.email !== TEST_EMAIL);
  store.transactions = store.transactions.filter((t) => t.userId !== user.id);
  fs.writeFileSync(path.join(__dirname, "..", "data", "db.json"), JSON.stringify(store, null, 2));
  console.log("  🧹 cleaned up");

  console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===\n");
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error("Test crashed:", e); process.exit(1); });