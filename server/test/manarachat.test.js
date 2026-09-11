/* Unit tests for section 6 — assistant wired to the live knowledge base.
   No LLM key = the callLlm path returns null, so every reply goes through
   offlineReply(context) — which is exactly what we verify here: the assistant
   now answers FROM the admin-curated FAQ + platform params.
*/
const assert = require("assert");
const chat = require("../src/ai/manaraChat");
const km = require("../src/knowledge");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra).slice(0, 260) : "")); }
}

function makeStore() {
  return {
    faq: [
      km.newFaq({ category: "billing", priority: 5,
        question: { ar: "كم سعر اشتراك اللاعب؟", en: "What is the gamer subscription price?" },
        answer: { ar: "اشتراك اللاعب 39 جنيهاً شهرياً.", en: "Gamer subscription is 39 EGP/month." } })
    ],
    platform_params: [
      km.newPlatformParam({ key: "price.gamer", group: "billing",
        label: { ar: "سعر اللاعب الشهري", en: "Gamer monthly price" }, value: 39 }),
      km.newPlatformParam({ key: "trial.days_gamer", group: "trial",
        label: { ar: "فترة التجربة المجانية للاعب", en: "Free trial (gamer)" }, value: 14 })
    ]
  };
}

console.log("\n=== Section 6: assistant ↔ knowledge base ===");

// language detection
ok("detectLang ar", chat.detectLang("كيف أسجل في منارة؟") === "ar");
ok("detectLang en", chat.detectLang("How do I register?") === "en");
ok("detectLang mixed stays ar", chat.detectLang("مرحبا، price please") === "ar");

// prompt injection
const msgs = chat.buildMessages("كم السعر؟", "س: ...\nج: 39", []);
ok("buildMessages injects context", msgs[0].content.indexOf("39") !== -1 && msgs.length === 2);

(async () => {
  // off-topic guard still fires
  const off = await chat.manaraChat({ message: "ما أخبار الطقس غداً؟", user: {}, store: makeStore() });
  ok("off-topic rejected by guard", off.scope === "offtopic" && off.provider === "guard" && off.reply.indexOf("مساعد Manara") !== -1, off);

  // Arabic price question → answered from the admin FAQ/params (offline path)
  const ar = await chat.manaraChat({ message: "كم سعر اشتراك اللاعب؟", user: {}, store: makeStore() });
  ok("offline reply from live FAQ", ar.reply.indexOf("39") !== -1, ar);
  ok("reply is grounded (no defaults)", ar.lang === "ar" && ar.scope === "manara", ar);

  // English question → English answer selected
  const en = await chat.manaraChat({ message: "How much is the gamer subscription?", user: {}, store: makeStore() });
  ok("English reply from live base", /39/.test(en.reply) && en.lang === "en", en);

  // Empty DB → static defaults still produce a grounded answer
  const empty = await chat.manaraChat({ message: "ما هي منصة منارة؟", user: {}, store: { faq: [], platform_params: [] } });
  ok("empty base → static defaults answer", empty.reply.length > 10 && /منارة/.test(empty.reply), empty.reply.slice(0, 90));

  // In-scope but no matching context anywhere → honest "not enough info"
  const none = await chat.manaraChat({ message: "كيف أراجع كشوفات الدفع القديمة؟", user: {}, store: makeStore() });
  ok("no context → honest no-info reply", none.reply.length > 0 && /لا أملك معلومات كافية/.test(none.reply), none.reply.slice(0, 80));

  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });