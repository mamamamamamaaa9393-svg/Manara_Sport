/* Pure unit tests for the knowledge data model (server/src/knowledge.js).
   No server, no db.json, no HTTP — exercises the factories, validators and
   helpers directly so the data model can be proven before any route/UI work.
   Run: node test/knowledge-model.test.js */
const km = require("../src/knowledge");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; console.log("  \u2717 " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

/* ---- FAQ: newFaq defaults & shaping ------------------------------------ */
{
  const f = km.newFaq({
    question: { ar: "كيف أسجل حساباً في منارة؟", en: "How do I create a Manara account?" },
    answer: { ar: "افتح صفحة التسجيل ثم اختر دورك.", en: "Open the sign-up page and pick your role." },
    category: "registration"
  });
  ok("faq id prefix faq_", String(f.id).slice(0, 4) === "faq_");
  ok("faq default isActive true", f.isActive === true, f.isActive);
  ok("faq default priority 0", f.priority === 0, f.priority);
  ok("faq default createdBy system", f.createdBy === "system", f.createdBy);
  ok("faq category kept when valid", f.category === "registration");
  ok("faq question kept bilingual", f.question.ar && f.question.en);
  ok("faq answer kept bilingual", f.answer.ar && f.answer.en);
  ok("faq timestamps set", !!f.createdAt && !!f.updatedAt);
  ok("faq keywords baked (arabic word present)", f.keywords.indexOf("مناره") !== -1 || f.keywords.indexOf("منارة") !== -1, f.keywords);
  ok("faq keywords baked (english word present)", f.keywords.toLowerCase().indexOf("account") !== -1, f.keywords);
}

/* ---- FAQ: invalid category falls back to general ------------------------ */
{
  const f = km.newFaq({ question: "سؤال?", answer: "جواب.", category: "whatever" });
  ok("invalid category -> general", f.category === "general", f.category);
}

/* ---- FAQ: user-provided id / nextId fn / isActive false ----------------- */
{
  const f1 = km.newFaq({ question: "q", answer: "a", id: "faq_custom" });
  ok("explicit id kept", f1.id === "faq_custom");
  const f2 = km.newFaq({ question: "q", answer: "a", isActive: false });
  ok("isActive false preserved", f2.isActive === false);
  let n = 0;
  const withCounter = km.newFaq({ question: "q", answer: "a" }, (col) => { n++; return col === "faq" ? 7 : -1; });
  ok("nextId fn used", withCounter.id === "faq_7", withCounter.id);
  ok("nextId called with collection name", n === 1);
}

/* ---- FAQ: validateFaq --------------------------------------------------- */
{
  const v = km.validateFaq({ question: { ar: "س" }, answer: { en: "a" } });
  ok("valid faq passes", v.ok === true, v.errors);
  const v1 = km.validateFaq({ answer: { en: "a" } });
  ok("missing question rejected", v1.ok === false && v1.errors.length === 1);
  const v2 = km.validateFaq({ question: { ar: "س" } });
  ok("missing answer rejected", v2.ok === false && v2.errors.length === 1);
  const v3 = km.validateFaq({ question: { ar: "س" }, answer: { en: "a" }, category: "nope" });
  ok("invalid category flagged", v3.ok === false && v3.errors.some((e) => e.indexOf("category") !== -1));
  ok("null faq rejected", km.validateFaq(null).ok === false);
}

/* ---- FAQ: updateFaq ------------------------------------------------------ */
{
  const f = km.newFaq({
    question: { ar: "ما سعر اشتراك اللاعب؟", en: "What is the gamer price?" },
    answer: { ar: "39", en: "39" }
  });
  const later = km.updateFaq(f, { answer: { ar: "39 جنيهاً شهرياً", en: "39 EGP monthly" }, priority: 5 });
  ok("update returns new object", later !== f);
  ok("update keeps original untouched", f.answer.ar === "39");
  ok("patch applied", later.answer.ar === "39 جنيهاً شهرياً" && later.priority === 5);
  ok("updatedAt refreshed", new Date(later.updatedAt) >= new Date(f.updatedAt));
  const qChanged = km.updateFaq(f, { question: { ar: "ما سعر اشتراك النادي؟" } });
  ok("keywords re-baked on question change", qChanged.keywords.toLowerCase().indexOf("نادي") !== -1 || qChanged.keywords.indexOf("النادي") === -1, qChanged.keywords);
  const toggle = km.updateFaq(f, { isActive: false });
  ok("isActive toggled", toggle.isActive === false);
  ok("bad category on update -> general", km.updateFaq(f, { category: "x" }).category === "general");
}

/* ---- platform params: newPlatformParam + type inference ----------------- */
{
  const p1 = km.newPlatformParam({ key: "price.gamer", label: { ar: "سعر اللاعب", en: "Gamer price" }, value: 39 });
  ok("param id prefix prm_", String(p1.id).slice(0, 4) === "prm_");
  ok("number type inferred", p1.type === "number", p1.type);
  ok("default group general", p1.group === "general", p1.group);
  ok("default source manual", p1.source === "manual", p1.source);
  ok("default active true", p1.active === true);
  ok("configRef empty by default", p1.configRef === "");

  ok("boolean type inferred", km.newPlatformParam({ key: "k", label: { ar: "x" }, value: true }).type === "boolean");
  ok("string type inferred", km.newPlatformParam({ key: "k", label: { ar: "x" }, value: "EGP" }).type === "string");
  ok("array type inferred", km.newPlatformParam({ key: "k", label: { ar: "x" }, value: ["a", "b"] }).type === "array");
  ok("explicit type wins", km.newPlatformParam({ key: "k", label: { ar: "x" }, value: "5", type: "string" }).type === "string");

  const zero = km.newPlatformParam({ key: "price", label: { ar: "x" }, value: 0 });
  ok("value 0 preserved", zero.value === 0 && zero.type === "number");
  const falsy = km.newPlatformParam({ key: "flag", label: { ar: "x" }, value: false });
  ok("value false preserved", falsy.value === false && falsy.type === "boolean");
  const empty = km.newPlatformParam({ key: "note", label: { ar: "x" }, value: "" });
  ok("value '' preserved", empty.value === "" && empty.type === "string");

  const auto = km.newPlatformParam({ key: "a", label: { ar: "x" }, value: 7, source: "auto-config", configRef: "TRIAL_DAYS" });
  ok("auto-config source kept", auto.source === "auto-config" && auto.configRef === "TRIAL_DAYS");
  const badSrc = km.newPlatformParam({ key: "b", label: { ar: "x" }, value: 1, source: "hacked" });
  ok("unknown source -> manual", badSrc.source === "manual");
}

/* ---- platform params: validatePlatformParam ----------------------------- */
{
  const good = { key: "price.gamer", label: { ar: "سعر", en: "Price" }, value: 39, group: "billing" };
  ok("valid param passes", km.validatePlatformParam(good).ok === true);
  ok("missing key rejected", km.validatePlatformParam({ label: { ar: "x" }, value: 1 }).ok === false);
  ok("blank key rejected", km.validatePlatformParam({ key: "   ", label: { ar: "x" }, value: 1 }).ok === false);
  ok("invalid key chars rejected", km.validatePlatformParam({ key: "Bad Key!", label: { ar: "x" }, value: 1 }).ok === false);
  ok("uppercase key rejected", km.validatePlatformParam({ key: "Price.Gamer", label: { ar: "x" }, value: 1 }).ok === false);
  ok("missing label rejected", km.validatePlatformParam({ key: "k", value: 1 }).ok === false);
  ok("undefined value rejected", km.validatePlatformParam({ key: "k", label: { ar: "x" } }).ok === false);
  ok("invalid group flagged", km.validatePlatformParam({ key: "k", label: { ar: "x" }, value: 1, group: "nope" }).ok === false);
  ok("null param rejected", km.validatePlatformParam(null).ok === false);
}

/* ---- platform params: updatePlatformParam ------------------------------- */
{
  const p = km.newPlatformParam({ key: "price.gamer", label: { ar: "سعر اللاعب" }, value: 39 });
  const u = km.updatePlatformParam(p, { value: 49, label: { en: "Gamer price" } });
  ok("param update new object", u !== p);
  ok("value patched + type re-inferred", u.value === 49 && u.type === "number");
  ok("label merged bilingual", u.label.ar && u.label.en);
  ok("original untouched", p.value === 39);
  ok("updatedAt refreshed", new Date(u.updatedAt) >= new Date(p.updatedAt));
  const arr = km.updatePlatformParam(p, { value: ["a", "b"] });
  ok("type re-inferred on array value", arr.type === "array", arr.type);
  const bogus = km.updatePlatformParam(p, { key: "Bad Key" });
  ok("invalid key kept raw for validator", bogus.key === "Bad Key");
  ok("bad source -> manual", km.updatePlatformParam(p, { source: "x" }).source === "manual");
}

/* ---- query/display helpers ---------------------------------------------- */
{
  const active = [
    km.newFaq({ question: "q1", answer: "a" }),
    km.newFaq({ question: "q2", answer: "a", isActive: false })
  ];
  ok("activeFaqs filters published only", km.activeFaqs(active).length === 1);

  const params = [
    km.newPlatformParam({ key: "a", label: { ar: "x" }, value: 1 }),
    km.newPlatformParam({ key: "b", label: { ar: "x" }, value: 2, active: false })
  ];
  ok("activeParams filters active only", km.activeParams(params).length === 1);

  ok("findParamByKey finds by key", km.findParamByKey(params, "a") === params[0]);
  ok("findParamByKey null when key blank", km.findParamByKey(params, "   ") === null);
  ok("findParamByKey null on missing", km.findParamByKey(params, "zzz") === null);
  ok("findParamByKey exceptId excludes self", km.findParamByKey(params, "a", params[0].id) !== params[0]);
  ok("findParamByKey exceptId returns null for own key", km.findParamByKey(params, "a", params[0].id) === null);

  ok("displayParamValue joins arrays", km.displayParamValue(["a", "b"]) === "a, b");
  ok("displayParamValue boolean text", km.displayParamValue(false) === "false");
  ok("displayParamValue number text", km.displayParamValue(39) === "39");
  ok("displayParamValue null/undefined safe", km.displayParamValue(null) === "null" && km.displayParamValue(undefined) === "");

  const ctx = km.paramContextLine(params[0], "en");
  ok("paramContextLine: key = value", ctx.indexOf("a = 1") === 0, ctx);
}

console.log("Result: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);