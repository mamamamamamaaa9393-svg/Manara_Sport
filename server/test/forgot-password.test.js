/* E2E test: forgot-password flow — reset code comes from the account, and
   after a successful reset the OLD password must NOT work anymore. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:5000";
const TEST_EMAIL = "test_fp_" + Date.now() + "@test.com";
const OLD_PASS = "OldPass123!";
const NEW_PASS = "NewPass456!";

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
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, raw: d }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

async function run() {
  console.log("\n=== Forgot-password flow test ===");

  // 1. register + verify + approve a fresh user
  const sv = await req("POST", "/api/auth/send-verification", { email: TEST_EMAIL });
  ok("send-verification", sv.status === 200 && sv.data && sv.data.verificationId, sv);
  const vId = sv.data.verificationId;
  const code = otpFrom(sv);
  ok("OTP generated", !!code);
  await req("POST", "/api/auth/verify-email", { verificationId: vId, code });

  const reg = await req("POST", "/api/auth/register", {
    role: "player",
    data: {
      full_name: "FP Test", email: TEST_EMAIL, password: OLD_PASS, password_confirm: OLD_PASS,
      sport: "Football", position: "GK",
      documents: { birth_cert: "/uploads/a.jpg", medical: "/uploads/b.jpg", declaration: "/uploads/c.jpg" },
      videos: [{ url: "/uploads/v.mp4" }]
    }
  });
  ok("register -> pending", reg.status === 201 && reg.data && reg.data.registrationId, reg);
  const adminLogin = await req("POST", "/api/auth/login", { email: "admin@manara.app", password: "AAMzTqUix%GFxa8DYS" });
  const adminToken = adminLogin.data && adminLogin.data.token;
  const appr = await req("POST", "/api/admin/registrations/" + reg.data.registrationId + "/approve", {}, adminToken);
  ok("admin approves user (so login works)", appr.status === 200, appr);

  // 2. forgot-password: dev response carries the reset code (SMTP on or off)
  const fp = await req("POST", "/api/auth/forgot-password", { email: TEST_EMAIL });
  ok("forgot-password returns generic message", fp.status === 200 && !!fp.data && !!fp.data.message, fp);
  const resetCode = fp.data && fp.data.devCode;
  ok("reset code returned for testing", !!resetCode, fp);

  // 3. reset-password with the code
  const rp = await req("POST", "/api/auth/reset-password", {
    code: resetCode, newPassword: NEW_PASS, newPasswordConfirm: NEW_PASS
  });
  ok("reset-password success", rp.status === 200, rp);

  // 4. OLD password must NOT work
  const oldLogin = await req("POST", "/api/auth/login", { email: TEST_EMAIL, password: OLD_PASS });
  ok("OLD password REJECTED after reset", oldLogin.status === 401, oldLogin);

  // 5. NEW password works
  const newLogin = await req("POST", "/api/auth/login", { email: TEST_EMAIL, password: NEW_PASS });
  ok("NEW password accepted", newLogin.status === 200 && newLogin.data && newLogin.data.token, newLogin);

  // 6. reset token consumed (single-use)
  const rp2 = await req("POST", "/api/auth/reset-password", {
    code: resetCode, newPassword: "Another456!", newPasswordConfirm: "Another456!"
  });
  ok("reset code single-use (reuse rejected)", rp2.status === 400, rp2);

  console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });