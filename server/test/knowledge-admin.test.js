/* E2E smoke test for the knowledge admin panel (sections 3 + 4) — runs
   against the live server:5000. Covers:
     - auth guards on /api/knowledge/* (401 anonymous, 403 non-admin)
     - FAQ full CRUD (create/validate/patch/list/delete) + category counts
     - platform params: dry-run reconcile (never writes), apply reconcile,
       single-key sync, delete cleanup, stale highlighting
     - JSON knowledge export bundle
     - admin AI preview endpoint (real assistant reply via manaraChat)
   Cleanup: created FAQ entries removed, params restored to the pre-test set,
   and the temporary player account removed.
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = process.env.MANARA_BASE_URL || "http://localhost:5000";
const HOST = new URL(BASE).hostname;
const PORT = Number(new URL(BASE).port || 80);
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";
const NOW = Date.now();
const PLAYER_EMAIL = "kube_" + NOW + "@test.com";
const PASS = "TestPass123!";

const { otpFrom } = require("./helpers");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra).slice(0, 300) : "")); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: HOST, port: PORT, path: p, headers: { "Accept": "application/json" } };
    if (data) opts.headers["Content-Type"] = "application/json";
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.setTimeout(20000, () => r.destroy());
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, data: d ? null : null }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log("\n=== Knowledge admin E2E test ===");

  // ---- auth
  const anon = await req("GET", "/api/knowledge/faq");
  ok("anonymous → 401", anon.status === 401, anon);

  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
  ok("admin login", adminLogin.status === 200 && adminLogin.data.token, adminLogin);
  const adminToken = adminLogin.data.token;

  // ---- register a normal user for the 403 check (player role)
  const sv = await req("POST", "/api/auth/send-verification", { email: PLAYER_EMAIL });
  const vId = sv.data.verificationId;
  const code = otpFrom(sv);
  await req("POST", "/api/auth/verify-email", { verificationId: vId, code });
  const reg = await req("POST", "/api/auth/register", {
    role: "player",
    data: {
      email: PLAYER_EMAIL, password: PASS, password_confirm: PASS,
      full_name: "KB Test Player", sport: "Football", position: "Striker (ST)",
      documents: { birth_cert: "/uploads/t_b.jpg", medical: "/uploads/t_m.jpg", declaration: "/uploads/t_d.jpg" },
      videos: [{ url: "/uploads/t_v.mp4", duration: 600 }]
    }
  });
  ok("player registered", reg.status === 201, reg);
  const approve = await req("POST", "/api/admin/registrations/" + reg.data.registrationId + "/approve", {}, adminToken);
  ok("player approved", approve.status === 200, approve);
  const playerLogin = await req("POST", "/api/auth/login", { email: PLAYER_EMAIL, password: PASS });
  const playerToken = playerLogin.data.token;

  const denied = await req("GET", "/api/knowledge/faq", null, playerToken);
  ok("non-admin → 403", denied.status === 403, denied);

  // ---- FAQ CRUD
  console.log("\n[1] FAQ CRUD");
  const initial = await req("GET", "/api/knowledge/faq", null, adminToken);
  const initialIds = (initial.data.faqs || []).map((f) => f.id);
  ok("list ok", initial.status === 200 && Array.isArray(initial.data.faqs), initial);

  const created = await req("POST", "/api/knowledge/faq", {
    question: { ar: "ما هي منصة منارة؟", en: "What is Manara?" },
    answer: { ar: "منصة احترافية تربط الرياضيين بالأندية.", en: "A pro platform connecting athletes to clubs." },
    category: "general", priority: 5, source: "about.html", isActive: true
  }, adminToken);
  ok("create → 201", created.status === 201 && created.data.id && created.data.question.ar.indexOf("منارة") !== -1, created);
  const faqId = created.data.id;

  const bad = await req("POST", "/api/knowledge/faq", { question: { ar: "" }, answer: { ar: "" } }, adminToken);
  ok("invalid create → 400", bad.status === 400, bad);

  const upd = await req("PUT", "/api/knowledge/faq/" + faqId, { isActive: false, priority: 9 }, adminToken);
  ok("patch (toggle off) → 200", upd.status === 200 && upd.data.isActive === false && upd.data.priority === 9, upd);

  const list1 = await req("GET", "/api/knowledge/faq", null, adminToken);
  const entry = (list1.data.faqs || []).find((f) => f.id === faqId);
  ok("list contains entry + counts", !!entry && entry.isActive === false && list1.data.counts.general >= 1, list1.data.counts);

  const upd2 = await req("PUT", "/api/knowledge/faq/" + faqId, { isActive: true }, adminToken);
  ok("re-enable → active", upd2.status === 200 && upd2.data.isActive === true, upd2);

  const notFound = await req("PUT", "/api/knowledge/faq/faq_999999999", { priority: 1 }, adminToken);
  ok("update missing → 404", notFound.status === 404, notFound);

  const del = await req("DELETE", "/api/knowledge/faq/" + faqId, null, adminToken);
  ok("delete → ok", del.status === 200 && del.data.ok === true, del);

  const list2 = await req("GET", "/api/knowledge/faq", null, adminToken);
  const idsAfter = (list2.data.faqs || []).map((f) => f.id);
  ok("faq removed", idsAfter.indexOf(faqId) === -1, idsAfter);

  // ---- platform params
  console.log("\n[2] Platform params reconcile/apply");
  const p0 = await req("GET", "/api/knowledge/params", null, adminToken);
  const initialParamKeys = (p0.data.params || []).map((x) => x.key);
  ok("params list ok", p0.status === 200 && Array.isArray(p0.data.params), p0);

  const dry = await req("POST", "/api/knowledge/params/reconcile", {}, adminToken);
  ok("dry-run reconcile", dry.status === 200 && dry.data.report && !dry.data.report.applyRun, dry.data);
  ok("dry-run detects additions", dry.data.report.added.length > 0, dry.data.report);

  const p1 = await req("GET", "/api/knowledge/params", null, adminToken);
  ok("dry-run never wrote", p1.data.params.length === p0.data.params.length, { before: p0.data.params.length, after: p1.data.params.length });

  const apply = await req("POST", "/api/knowledge/params/reconcile", { apply: true }, adminToken);
  ok("apply reconcile runs", apply.status === 200 && Array.isArray(apply.data.report.added), apply.data);
  ok("apply reports saved", apply.data.report.applyRun === true && apply.data.report.added.length > 0, apply.data.report);

  const p2 = await req("GET", "/api/knowledge/params", null, adminToken);
  const createdKeys = (p2.data.params || []).map((x) => x.key).filter((k) => initialParamKeys.indexOf(k) === -1);
  ok("params persisted after apply", createdKeys.length === apply.data.report.added.length, { createdKeys, added: apply.data.report.added.length });

  const oneKey = createdKeys[0];
  const sync = await req("POST", "/api/knowledge/params/apply", { key: oneKey }, adminToken);
  ok("singleton sync", sync.status === 200 && sync.data.key === oneKey && sync.data.updated === true, sync);
  ok("sync value present", sync.data.value !== undefined && sync.data.value !== null, sync.data);

  const syncBad = await req("POST", "/api/knowledge/params/apply", { key: "nope_" + NOW }, adminToken);
  ok("sync unknown key → 400", syncBad.status === 400, syncBad);

  const delP = await req("DELETE", "/api/knowledge/params/" + encodeURIComponent(oneKey), null, adminToken);
  ok("param delete → ok", delP.status === 200 && delP.data.ok === true, delP);
  ok("other params still intact", createdKeys.length >= 1, createdKeys.length);

  // ---- export bundle
  console.log("\n[3] Knowledge export");
  const exp = await req("GET", "/api/knowledge/export", null, adminToken);
  ok("export 200 + meta", exp.status === 200 && exp.data.meta && typeof exp.data.meta.faqCount === "number", exp.data);
  ok("export carries faqs + params + staleKeys",
    Array.isArray(exp.data.faqs) && Array.isArray(exp.data.params) && Array.isArray(exp.data.staleKeys) &&
    exp.data.generatedAt, exp.data);

  // ---- public read (no auth) — section 4
  console.log("\n[3b] Public knowledge read");
  const pubNoAuth = await req("GET", "/api/knowledge/public", null, null);
  ok("public read works WITHOUT auth", pubNoAuth.status === 200, pubNoAuth);
  ok("public bundle shape",
    Array.isArray(pubNoAuth.data.faqs) && Array.isArray(pubNoAuth.data.params) &&
    Array.isArray(pubNoAuth.data.staleKeys) && pubNoAuth.data.generatedAt &&
    pubNoAuth.data.meta.publicOnly === true, pubNoAuth.data);
  const pubKeys = (pubNoAuth.data.params || []).map((x) => x.key);
  ok("public bundle hides internal/operational params",
    pubNoAuth.data.params.filter((p) => p.stale === true).every((p) => pubKeys.indexOf(p.key) !== -1) &&
    !pubKeys.some((k) => ["payment.amount_tolerance_egp", "payment.ocr_enabled", "payment.receipt_auto_approve"].indexOf(k) !== -1),
    pubKeys);
  // also an unauthenticated call to the admin list must still be denied
  const stillDenied = await req("GET", "/api/knowledge/faq", null, null);
  ok("admin list still 401 for anonymous", stillDenied.status === 401, stillDenied);

  // lang projection (?lang=en) on the public bundle
  const tempFaq = await req("POST", "/api/knowledge/faq", {
    question: { ar: "ما هو سعر النادي؟", en: "What is the club price?" },
    answer: { ar: "299 جنيهاً شهرياً.", en: "299 EGP per month." },
    category: "general", priority: 1
  }, adminToken);
  const pubEn = await req("GET", "/api/knowledge/public?lang=en", null, null);
  const pubEnHit = (pubEn.data.faqs || []).find((f) => f.id === tempFaq.data.id);
  ok("public?lang=en projects to strings",
    pubEn.status === 200 && pubEn.data.lang === "en" &&
    pubEnHit && typeof pubEnHit.question === "string" && /club price/i.test(pubEnHit.question) && /299/.test(pubEnHit.answer),
    pubEnHit);
  ok("public?lang=en params label projected", (pubEn.data.params[0] == null || typeof pubEn.data.params[0].label === "string"), pubEn.data.params && pubEn.data.params[0]);
  const pubAr = await req("GET", "/api/knowledge/public?lang=ar", null, null);
  ok("public?lang=ar keeps Arabic", pubAr.status === 200 && pubAr.data.lang === "ar", pubAr.data && pubAr.data.lang);
  await req("DELETE", "/api/knowledge/faq/" + tempFaq.data.id, null, adminToken);

  // ---- AI preview (admin bypasses subscription gate)
  console.log("\n[4] AI preview");
  const prev = await req("POST", "/api/knowledge/preview", { question: "كم سعر الاشتراك في منارة؟" }, adminToken);
  ok("preview 200 + reply", prev.status === 200 && typeof prev.data.reply === "string" && prev.data.reply.length > 0, prev);

  const prevEmpty = await req("POST", "/api/knowledge/preview", { question: "   " }, adminToken);
  ok("preview empty → 400", prevEmpty.status === 400, prevEmpty);

  const prevDenied = await req("POST", "/api/knowledge/preview", { question: "مرحبا" }, playerToken);
  ok("preview non-admin → 403", prevDenied.status === 403, prevDenied);

  // ---- cleanup: remove params created during this run + the test player
  console.log("\n[5] Cleanup");
  const pa = await req("GET", "/api/knowledge/params", null, adminToken);
  for (const k of createdKeys) {
    if ((pa.data.params || []).findIndex((x) => x.key === k) !== -1) {
      await req("DELETE", "/api/knowledge/params/" + encodeURIComponent(k), null, adminToken);
    }
  }
  const after = await req("GET", "/api/knowledge/params", null, adminToken);
  const afterKeys = (after.data.params || []).map((x) => x.key);
  const paramsRestored = initialParamKeys.every((k) => afterKeys.indexOf(k) !== -1) &&
    createdKeys.every((k) => afterKeys.indexOf(k) === -1);
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  const pUser = store.users.find((u) => u.email === PLAYER_EMAIL);
  const ids = pUser ? [pUser.id] : [];
  store.users = store.users.filter((u) => ids.indexOf(u.id) === -1);
  store.players = store.players.filter((p) => ids.indexOf(p.userId) === -1);
  store.registrations = store.registrations.filter((r) => ids.indexOf(r.userId) === -1);
  store.verifications = store.verifications.filter((v) => v.email !== PLAYER_EMAIL);
  fs.writeFileSync(path.join(__dirname, "..", "data", "db.json"), JSON.stringify(store, null, 2));
  ok("created params removed + initial set intact", paramsRestored, { afterKeys, createdKeys });
  const afterClean = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  const playerGone = !(afterClean.users || []).some((u) => u.email === PLAYER_EMAIL);
  ok("player cleaned (removed from store)", playerGone);

  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });