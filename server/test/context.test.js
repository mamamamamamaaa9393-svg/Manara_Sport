/* Unit tests for section 5 — ingest + RAG-lite (server/src/ai/context.js).
   Pure function coverage only (a fake store is passed in, no HTTP, no db
   dependency). Verifications:
     - active-only ingestion (inactive faq/param excluded)
     - lang-aware render (ar vs en)
     - buildContext returns top answers + relevant params + context string
     - keyword-overlap relevance (price question → price answer & price params)
     - static-defaults fallback when the DB base is empty
     - k clamping (1..6) and only="param" / only="faq" filters
*/
const assert = require("assert");
const ctx = require("../src/ai/context");
const km = require("../src/knowledge");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra).slice(0, 260) : "")); }
}

const NOW = new Date().toISOString();
function makeStore() {
  return {
    faq: [
      km.newFaq({ category: "billing", priority: 9,
        question: { ar: "كم سعر اشتراك اللاعب في منارة؟", en: "How much is the gamer subscription?" },
        answer: { ar: "سعر اشتراك اللاعب 39 جنيهاً شهرياً.", en: "The gamer subscription costs 39 EGP/month." } }),
      km.newFaq({ category: "registration", isActive: false,
        question: { ar: "سؤال معطل لا يظهر", en: "Inactive question" },
        answer: { ar: "لا يجب أن يظهر", en: "Should not appear" } }),
      km.newFaq({ category: "features",
        question: { ar: "ما هي طريقة عمل الفيديوهات؟", en: "How do videos work?" },
        answer: { ar: "يرفع اللاعب فيديو مهارات من دقيقة إلى 10 دقائق.", en: "Players upload a 1-10 minute highlight." } })
    ],
    platform_params: [
      km.newPlatformParam({ key: "price.gamer", group: "billing",
        label: { ar: "سعر اللاعب الشهري", en: "Gamer monthly price" }, value: 39 }),
      km.newPlatformParam({ key: "price.club", group: "billing",
        label: { ar: "سعر النادي الشهري", en: "Club monthly price" }, value: 299 }),
      km.newPlatformParam({ key: "payment.manara_wallets", group: "payment", active: false,
        label: { ar: "محفظة معطلة", en: "Disabled wallet" }, value: "0550000000" })
    ]
  };
}

console.log("\n=== Section 5: ingest + RAG-lite ===");

// ingest active-only
const ing = ctx.ingestStore(makeStore(), { lang: "ar" });
ok("ingest returns both kinds", ing.entries.some((e) => e.kind === "faq") && ing.entries.some((e) => e.kind === "param"));
ok("inactive faq excluded", !ing.entries.some((e) => e.kind === "faq" && e.faqId && e.faqId.endsWith("2")));
ok("inactive param excluded", !ing.entries.some((e) => e.kind === "param" && e.key === "payment.manara_wallets"));
ok("no defaults used with real store", ing.usedDefaults === false);

// lang-aware render
const ar = ctx.buildContext("سعر اشتراك اللاعب", { store: makeStore(), lang: "ar", k: 3 });
ok("ar: returns top faq", ar.faqs.length >= 1 && ar.faqs[0].answer.ar.indexOf("39") !== -1, ar.faqs[0]);
ok("ar: returns relevant params", ar.params.some((p) => p.key === "price.gamer" || p.key === "price.club"), ar.params);
ok("ar: context string injectable", ar.context.indexOf("سعر اشتراك اللاعب") !== -1 && ar.context.indexOf("39") !== -1, ar.context.slice(0, 200));

const en = ctx.buildContext("How much is gamer subscription?", { store: makeStore(), lang: "en", k: 3 });
ok("en: English answer returned", en.faqs.length >= 1 && en.faqs.some((f) => /subscri|monthly/i.test(f.answer.en || "")), en.faqs);
ok("en: context uses English text", en.context.indexOf("gamer subscription") !== -1 || en.context.indexOf("monthly") !== -1, en.context.slice(0, 200));

// relevance ordering: price query should rank the price faq above video faq
const price = ctx.buildContext("الاشتراك سعر شهري", { store: makeStore(), lang: "ar", k: 3 });
ok("price question ranks price faq first", price.faqs.length && price.faqs[0].category === "billing", price.faqs.map((f) => f.category));

// k clamp
const bigK = ctx.buildContext("الفيديوهات", { store: makeStore(), lang: "ar", k: 99 });
ok("k clamped to 6", bigK.k === 6 && bigK.faqs.length <= 6, { k: bigK.k, n: bigK.faqs.length });
const tinyK = ctx.buildContext("الفيديوهات", { store: makeStore(), lang: "ar", k: 0 });
ok("k clamped to 1", tinyK.k === 1, tinyK.k);
const noK = ctx.buildContext("الفيديوهات", { store: makeStore(), lang: "ar" });
ok("default k = 5", noK.k === 5, noK.k);

// only= param filtering
const onlyP = ctx.buildContext("سعر النادي", { store: makeStore(), lang: "ar", only: "param", k: 5 });
ok("only=param → faqs empty, params present", onlyP.faqs.length === 0 && onlyP.params.some((p) => p.key === "price.club"), onlyP);

// video question matches via substring and shows the video faq
const vid = ctx.buildContext("فيديوهات اللاعبين كيف ترفع؟", { store: makeStore(), lang: "ar" });
ok("video faq found", vid.faqs.some((f) => f.category === "features"), vid.faqs.map((f) => f.category));

// static-defaults fallback on an empty store
const empty = ctx.buildContext("ما هي منصة منارة؟", { store: { faq: [], platform_params: [] }, lang: "ar" });
ok("empty store → static defaults used", empty.usedDefaults === true, empty.usedDefaults);
ok("defaults still produce context", empty.context.length > 0 && empty.context.indexOf("منصة") !== -1, empty.context.slice(0, 120));

console.log("\nResult: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);