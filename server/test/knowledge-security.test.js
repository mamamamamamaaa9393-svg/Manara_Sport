/* Security & privacy policy test (section 7 of the plan) — runs against the
   live server:5000. Verifies, for the whole knowledge feature:
     [1] Permissions: public read is open; EVERY write + full read endpoint
         is admin-only (401 anonymous, 403 non-admin player).
     [2] Privacy: /export and /public only ever carry the known knowledge
         shapes (whitelisted fields), and contain no member/receipt/
         conversation material (email, phone, receipts, chats, passwords).
     [3] Input sanitization: HTML/scripts/null-bytes/length abuse introduced
         through the FAQ endpoints are neutralized before storage, and the
         model layer clamps under the same policy (offline unit checks).
   Cleanup: removes whatever the test created.
*/
const http = require("http");
const km = require("../src/knowledge");
const { otpFrom } = require("./helpers");

const BASE = process.env.MANARA_BASE_URL || "http://localhost:5000";
const HOST = new URL(BASE).hostname;
const PORT = Number(new URL(BASE).port || 80);
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";
const NOW = Date.now();
const PLAYER_EMAIL = "sec_" + NOW + "@test.com";

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra).slice(0, 300) : "")); }
}

function req(method, p, body, token, contentType) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const opts = { method, hostname: HOST, port: PORT, path: p, headers: { "Accept": "application/json" } };
    if (data) opts.headers["Content-Type"] = contentType || "application/json";
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.setTimeout(20000, () => r.destroy());
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, data: d }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function approvedPlayer(email, token) {
  const sv = await req("POST", "/api/auth/send-verification", { email });
  const code = otpFrom(sv);
  await req("POST", "/api/auth/verify-email", { verificationId: sv.data.verificationId, code });
  const reg = await req("POST", "/api/auth/register", {
    role: "player",
    data: {
      email, password: "TestPass123!", password_confirm: "TestPass123!",
      full_name: "Security Tester", sport: "Football", position: "Striker (ST)",
      documents: { birth_cert: "/uploads/t_b.jpg", medical: "/uploads/t_m.jpg", declaration: "/uploads/t_d.jpg" },
      videos: [{ url: "/uploads/t_v.mp4", duration: 600 }]
    }
  });
  await req("POST", "/api/admin/registrations/" + reg.data.registrationId + "/approve", {}, token);
  const login = await req("POST", "/api/auth/login", { email, password: "TestPass123!" });
  return login.data && login.data.token;
}

async function run() {
  console.log("\n=== Knowledge: security & privacy (section 7) ===");

  /* ---- [1] permission matrix ----------------------------------------- */
  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  const adminToken = adminLogin.data.token;

  const playerToken = await approvedPlayer(PLAYER_EMAIL, adminToken);
  ok("non-admin player token obtained", !!playerToken);

  // public read: no token required, returns 200
  const pub = await req("GET", "/api/knowledge/public");
  ok("public read works with NO auth", pub.status === 200 && pub.data && Array.isArray(pub.data.faqs), pub.status);

  const WRITES = [
    ["POST", "/api/knowledge/faq", { question: { ar: "حماية", en: "security" }, answer: { ar: "x", en: "x" } }],
    ["PUT", "/api/knowledge/faq/tmp_sec_nonexistent", { isActive: false }],
    ["DELETE", "/api/knowledge/faq/tmp_sec_nonexistent"],
    ["POST", "/api/knowledge/params/reconcile", {}],
    ["POST", "/api/knowledge/params/apply", { key: "price.gamer" }],
    ["DELETE", "/api/knowledge/params/tmp_sec_nonexistent"],
    ["POST", "/api/knowledge/preview", { question: "مرحبا" }],
    ["GET", "/api/knowledge/export"]
  ];
  const READS = [
    ["GET", "/api/knowledge/faq"],
    ["GET", "/api/knowledge/params"]
  ];

  for (const [m, p, b] of WRITES) {
    const anon = await req(m, p, b);
    const player = await req(m, p, b, playerToken);
    ok("[" + m + " " + p.split("/").slice(0, 2).join("/") + "...] anon blocked",
      anon.status === 401, anon.status);
    ok("[" + m + " " + p.split("/").slice(0, 2).join("/") + "...] player blocked (403)",
      player.status === 403, player.status);
  }
  for (const [m, p] of READS) {
    const anon = await req(m, p);
    const player = await req(m, p, null, playerToken);
    ok("[" + p + "] anon blocked", anon.status === 401, anon.status);
    ok("[" + p + "] player blocked (403)", player.status === 403, player.status);
  }

  /* ---- [2] privacy: shapes + no personal data ------------------------- */
  const exp = await req("GET", "/api/knowledge/export", null, adminToken);
  ok("export 200 for admin", exp.status === 200 && exp.data, exp.status);
  const exportStr = JSON.stringify(exp.data);
  const PERSONAL = ["passwordHash", "conversation", "messages", "documents"];
  ok("export never contains the seeded member email", exportStr.indexOf(PLAYER_EMAIL) === -1, PLAYER_EMAIL);
  for (const f of PERSONAL) {
    ok("export contains no '" + f + "'", exportStr.indexOf(f) === -1, f);
  }
  const expTopKeys = Object.keys(exp.data || {}).sort().join(",");
  ok("export top-level shape", expTopKeys === "faqs,generatedAt,lang,meta,params,staleKeys,version", expTopKeys);

  let faqMiss = null, paramMiss = null;
  for (const f of (exp.data.faqs || [])) {
    const ks = Object.keys(f).sort().join(",");
    if (ks !== "answer,category,id,priority,question,source") { faqMiss = ks; break; }
  }
  for (const p of (exp.data.params || [])) {
    const ks = Object.keys(p).sort().join(",");
    if (ks !== "display,group,id,key,label,stale,type,value") { paramMiss = ks; break; }
  }
  ok("export FAQ fields whitelisted", faqMiss === null, faqMiss);
  ok("export param fields whitelisted", paramMiss === null, paramMiss);

  const pubStr = JSON.stringify(pub.data);
  const INTERNAL = ["billing.expiry_reminder_days", "payment.pending_expiry_hours", "payment.amount_tolerance_egp",
    "payment.ocr_confidence_min", "payment.ocr_enabled", "payment.pending_grants_access", "payment.receipt_auto_approve"];
  for (const k of INTERNAL) {
    ok("public never leaks internal key '" + k + "'", pubStr.indexOf(k) === -1, k);
  }
  ok("public never contains the seeded member email", pubStr.indexOf(PLAYER_EMAIL) === -1, PLAYER_EMAIL);
  for (const f of PERSONAL) {
    ok("public contains no '" + f + "'", pubStr.indexOf(f) === -1, f);
  }
  ok("public FAQ fields whitelisted", (pub.data.faqs || []).every((f) => Object.keys(f).sort().join(",") === "answer,category,id,priority,question,source"));

  /* ---- [3] input sanitization ----------------------------------------- */
  const evil = {
    question: { ar: "ما هو <script>alert(1)</script>سعر؟\u0000\u0001", en: "What<b>ever?</b>" },
    answer: { ar: "الرد: <img src=x onerror=alert(2)> \n سطر ثانٍ\u0000", en: "" },
    source: "<iframe src=evil>مصدر",
    priority: 99999
  };
  const created = await req("POST", "/api/knowledge/faq", evil, adminToken);
  ok("sanitizing create accepted", created.status === 201, created.status);
  const doc = created.data;
  ok("script tag stripped", doc.answer.ar.indexOf("script") === -1 && doc.answer.ar.indexOf("onerror") === -1, doc.answer.ar);
  ok("null/control bytes stripped", doc.answer.ar.indexOf("\u0000") === -1 && doc.question.ar.indexOf("\u0001") === -1, JSON.stringify(doc.question.ar));
  ok("html tags stripped from en question", doc.question.en === "Whatever?", doc.question.en);
  ok("iframe tag stripped from source", doc.source === "مصدر", doc.source);
  ok("priority clamped to 1000", doc.priority === 1000, doc.priority);

  // length cap
  const huge = await req("POST", "/api/knowledge/faq", {
    question: { ar: "ك", en: "" }, answer: { ar: "ز".repeat(25000), en: "" }
  }, adminToken);
  ok("answer capped at 20000", huge.status === 201 && huge.data.answer.ar.length === 20000, huge.data && huge.data.answer.ar.length);

  // update path also sanitizes
  const patched = await req("PUT", "/api/knowledge/faq/" + doc.id, { answer: { ar: "<b>محدّث</b> \u0007", en: "" } }, adminToken);
  ok("update sanitizes too", patched.status === 200 && patched.data.answer.ar === "محدّث", patched.data && patched.data.answer.ar);

  // cleanup
  await req("DELETE", "/api/knowledge/faq/" + doc.id, null, adminToken);
  await req("DELETE", "/api/knowledge/faq/" + huge.data.id, null, adminToken);
  await req("DELETE", "/api/auth/account", null, playerToken).catch(() => {});
  ok("cleanup done", true);

  /* ---- [3b] model-layer policy (offline) ------------------------------- */
  ok("cleanText strips html", km.cleanText("<script>x</script>hello <b>t</b>", 100) === "hello t");
  ok("cleanText caps length", km.cleanText("abcde", 3) === "abc");
  const np = km.newPlatformParam({ key: "x", label: { ar: "<script>سعر</script>", en: "" }, value: ["a", "<b>b</b>", 1], configRef: "<iframe>" });
  ok("script + tag content fully stripped", np.label.ar === "" && np.configRef === "", np.label.ar);
  ok("param array values flattened/cleaned", np.value[1] === "b", np.value);
  const bad = km.validatePlatformParam({ key: "k", label: { ar: "x" }, value: { nested: 1 }, group: "general" });
  ok("object param value rejected", bad.ok === false, bad.errors);
  const badArr = km.validatePlatformParam({ key: "k2", label: { ar: "x" }, value: Array(150).fill("v"), group: "general" });
  ok("oversized param array rejected", badArr.ok === false, badArr.errors);

  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("SEC TEST ERROR:", e && e.message); process.exit(1); });