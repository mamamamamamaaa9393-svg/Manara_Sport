/* Live integration: seed real content via the API, then confirm that
   context.buildContext (a SEPARATE process reading the same db.json that the
   live server persists) retrieves the admin's FAQ + the platform params.
   Restores the store (deletes the created FAQ + params) afterwards. */
const http = require("http");
const ctx = require("../src/ai/context");
const db = require("../src/db");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? " -> " + JSON.stringify(extra).slice(0, 240) : "")); }
}

const BASE = process.env.MANARA_BASE_URL || "http://localhost:5000";
const HOST = new URL(BASE).hostname;
const PORT = Number(new URL(BASE).port || 80);

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: HOST, port: PORT, path: p, headers: { "Accept": "application/json" } };
    if (data) opts.headers["Content-Type"] = "application/json";
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, data: null }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log("\n=== Section 5 live RAG integration ===");
  const login = await req("POST", "/api/auth/login", { email: "admin@manara.app", password: "AAMzTqUix%GFxa8DYS" });
  const t = login.data.token;
  const created = await req("POST", "/api/knowledge/faq", {
    question: { ar: "كم سعر اشتراك اللاعب في منارة؟", en: "" },
    answer: { ar: "اشتراك اللاعب 39 جنيهاً شهرياً.", en: "" },
    category: "billing", priority: 5
  }, t);
  ok("seed faq created", created.status === 201, created);
  const apply = await req("POST", "/api/knowledge/params/reconcile", { apply: true }, t);
  const keysCreated = (apply.data.report.added || []);
  ok("params applied from config", keysCreated.length > 0, apply.data.report.added);

  // separate process reads the same db.json the server just saved
  db.load();
  const res = ctx.buildContext("كم سعر اشتراك اللاعب", { lang: "ar", k: 4 });
  ok("faq retrieved from live store", res.faqs.some((f) => /39/.test(f.answer.ar)), res.faqs);
  ok("relevant param retrieved", res.params.some((p) => p.key === "price.gamer" && p.value === 39), res.params);
  ok("context includes both", res.context.indexOf("39") !== -1 && res.context.indexOf("سعر اللاعب الشهري (ج.م)") !== -1, res.context.slice(0, 180));
  ok("no defaults fallback on live content", res.usedDefaults === false, res.usedDefaults);

  // restore: delete the faq + created params
  await req("DELETE", "/api/knowledge/faq/" + created.data.id, null, t);
  for (const k of keysCreated) await req("DELETE", "/api/knowledge/params/" + encodeURIComponent(k), null, t);
  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("INTEGRATION ERROR:", e); process.exit(1); });