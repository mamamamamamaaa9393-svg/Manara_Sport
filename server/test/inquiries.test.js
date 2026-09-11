/* Inquiries (استفسارات) feature test.
   Runs against the LIVE server on localhost:5000.

   Flow tested:
     1. Public submit an inquiry -> 201 + secret token + trackUrl
     2. Validate required fields -> 400
     3. Track endpoint (token-gated) returns the inquiry
     4. Admin list requires auth -> 401 without token
     5. Admin login -> list includes inquiry, open count >= 1
     6. Admin replies -> status answered
     7. Track endpoint now shows the reply (private, only via token)
*/
const http = require("http");
const BASE = process.env.MANARA_BASE_URL || "http://localhost:5000";
const HOST = new URL(BASE).hostname;
const PORT = Number(new URL(BASE).port || 80);
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";

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
      hostname: HOST,
      port: PORT,
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

async function run() {
  console.log("\n=== Inquiries (استفسارات) feature test ===");

  // 1. Public submit
  const subj = "billing";
  const submit = await req("POST", "/api/inquiries", {
    name: "سارة أحمد",
    email: "sara.inq." + Date.now() + "@test.com",
    subject: subj,
    message: "هل يمكن ترقية الاشتراك من لاعب إلى نادي؟"
  });
  ok("public submit returns 201", submit.status === 201, submit.data);
  ok("submit returns secret token", !!(submit.data && submit.data.token), submit.data);
  ok("submit returns trackUrl", !!(submit.data && submit.data.trackUrl), submit.data);
  const token = submit.data && submit.data.token;
  const inqId = submit.data && submit.data.id;

  // 2. Validation
  const bad = await req("POST", "/api/inquiries", { name: "x" });
  ok("missing email/message -> 400", bad.status === 400, bad.data);
  const badEmail = await req("POST", "/api/inquiries", { name: "x", email: "notanemail", message: "hi" });
  ok("invalid email -> 400", badEmail.status === 400, badEmail.data);

  // 3. Track endpoint
  const track = await req("GET", "/api/inquiries/track/" + encodeURIComponent(token));
  ok("track returns 200", track.status === 200, track.data);
  ok("track returns the message", track.data && track.data.message && track.data.message.indexOf("ترقية") !== -1, track.data);
  ok("track status is open", track.data && track.data.status === "open", track.data);

  // 4. Admin list requires auth
  const noAuth = await req("GET", "/api/admin/inquiries");
  ok("admin list without token -> 401", noAuth.status === 401, noAuth.data);

  // 5. Admin login + list
  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  ok("admin login", adminLogin.status === 200 && adminLogin.data && adminLogin.data.token, adminLogin.data);
  const adminToken = adminLogin.data.token;
  const list = await req("GET", "/api/admin/inquiries?status=open", null, adminToken);
  ok("admin list returns 200", list.status === 200, list.data);
  ok("admin list includes our inquiry", list.data && Array.isArray(list.data.inquiries) &&
    list.data.inquiries.some((i) => String(i.id) === String(inqId)), list.data);
  ok("open count >= 1", list.data && list.data.counts && list.data.counts.open >= 1, list.data);

  // 6. Admin reply
  const reply = await req("POST", "/api/admin/inquiries/" + encodeURIComponent(inqId) + "/reply",
    { reply: "نعم، يمكن الترقية من لوحة الإعدادات." }, adminToken);
  ok("admin reply returns 200", reply.status === 200, reply.data);
  ok("reply sets status answered", reply.data && reply.data.inquiry && reply.data.inquiry.status === "answered", reply.data);

  // 7. Track now shows reply (private, token-gated)
  const track2 = await req("GET", "/api/inquiries/track/" + encodeURIComponent(token));
  ok("track shows reply", track2.data && track2.data.reply && track2.data.reply.indexOf("الترقية") !== -1, track2.data);
  ok("track status answered", track2.data && track2.data.status === "answered", track2.data);

  console.log("\n=== Inquiries test result: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error("FATAL", e); process.exit(1); });
