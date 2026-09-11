/* ==========================================================================
   Knowledge content management (admin-only) — sections 3 + 4 of the plan.
   Backs the admin-faq.html panel:
     GET    /api/knowledge/faq                        list (sorted, with counts)
     POST   /api/knowledge/faq                        create
     PUT    /api/knowledge/faq/:id                    update
     DELETE /api/knowledge/faq/:id                    delete
     GET    /api/knowledge/params                     list platform params
     POST   /api/knowledge/params/reconcile           dry-run diff vs config
     POST   /api/knowledge/params/apply               force-sync one param
     GET    /api/knowledge/export                     active content for the AI
   All routes require a signed-in admin (requireAuth + requireAdmin).
   The public read path used by the AI assistant is added in section 5/6.
   ========================================================================== */
const router = require("express").Router();
const db = require("../db");
const rateLimit = require("../middleware/rateLimit");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const km = require("../knowledge");
const ps = require("../paramsSource");

// Admin-only preview limiter (the AI paywall gate is skipped here on purpose —
// the admin tests answers without needing an active subscription).
const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "طلبات كثيرة إلى المعاينة — حاول بعد قليل",
  key: (req) => (req.user && req.user.id) || (req.ip || "unknown")
});

const FAQ_CATEGORY_LABELS = {
  general: "عام",
  registration: "التسجيل",
  verification: "التحقق من البريد",
  login: "تسجيل الدخول",
  billing: "الفوترة",
  payment: "الدفع",
  profile: "الملف الشخصي",
  features: "مزايا المنصة",
  ai_assistant: "المساعد الذكي"
};

// paramsSource expects the store to expose save()/nextId() (mock-style API).
// The live db.get() object doesn't — attach thin delegates once, idempotently,
// so reconcile/apply persist through db.save() and generate real "prm_" ids.
// Functions are dropped by JSON.stringify, so this never pollutes db.json.
function persistedStore(store) {
  if (typeof store.save !== "function") store.save = () => db.save();
  if (typeof store.nextId !== "function") store.nextId = (c) => db.nextId(c);
  return store;
}

// Active content bundle (AI-ready). `publicOnly` strips the operational
// (internal) params so nothing beyond the marketing-facing facts leaks.
// `lang` (ar|en) projects question/answer and param label/value to a single
// clean language; omitting it keeps the bilingual objects.
function buildKnowledgeBundle(store, publicOnly, lang) {
  const now = new Date().toISOString();
  const single = lang === "en" || lang === "ar" ? lang : null;
  const faqs = km.activeFaqs(store.faq).map((f) => {
    const base = { id: f.id, category: f.category, priority: f.priority };
    if (single) {
      base.question = single === "ar" ? (f.question.ar || f.question.en) : (f.question.en || f.question.ar);
      base.answer = single === "ar" ? (f.answer.ar || f.answer.en) : (f.answer.en || f.answer.ar);
    } else {
      base.question = f.question;
      base.answer = f.answer;
    }
    base.source = f.source;
    return base;
  });
  const all = km.activeParams(store.platform_params);
  const params = all
    .filter((p) => !(publicOnly && ps.isInternalParamKey(p.key)))
    .map((p) => {
      const v = p.stale === true && p.configValue !== null && p.configValue !== undefined ? p.configValue : p.value;
      const base = { id: p.id, key: p.key, group: p.group, value: v, stale: p.stale === true };
      if (p.type) base.type = p.type;
      if (single) base.label = single === "ar" ? (p.label.ar || p.label.en || "") : (p.label.en || p.label.ar || "");
      else base.label = p.label;
      base.display = km.displayParamValue(v);
      return base;
    });
  const staleKeys = params.filter((p) => p.stale === true).map((p) => p.key);
  return {
    version: 1,
    generatedAt: now,
    lang: single || "both",
    faqs,
    params,
    staleKeys,
    meta: { publicOnly: !!publicOnly, faqCount: faqs.length, paramCount: params.length }
  };
}

const PARAM_GROUP_LABELS = {
  billing: "الفوترة",
  trial: "التجربة المجانية",
  payment: "الدفع",
  upload: "الرفع",
  registration: "التسجيل",
  general: "عام"
};

function listFaqs(store) {
  return store.faq.slice().sort((a, b) => {
    if ((a.priority || 0) !== (b.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}

// GET /api/knowledge/faq — list all FAQ entries + category counts.
router.get("/faq", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const list = listFaqs(store);
  const counts = {};
  km.FAQ_CATEGORIES.forEach((c) => { counts[c] = 0; });
  list.forEach((f) => { counts[f.category] = (counts[f.category] || 0) + 1; });
  res.json({ faqs: list, counts, categories: km.FAQ_CATEGORIES, categoryLabels: FAQ_CATEGORY_LABELS });
});

// POST /api/knowledge/faq — create an FAQ entry.
router.post("/faq", requireAuth, requireAdmin, (req, res) => {
  const doc = km.newFaq(req.body || {}, db.nextId);
  const v = km.validateFaq(doc);
  if (!v.ok) return res.status(400).json({ error: v.errors.join("; ") });
  db.get().faq.push(doc);
  db.save();
  res.status(201).json(doc);
});

// PUT /api/knowledge/faq/:id — update an FAQ entry (partial patch).
router.put("/faq/:id", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const idx = store.faq.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "FAQ not found" });
  const updated = km.updateFaq(store.faq[idx], req.body || {});
  const v = km.validateFaq(updated);
  if (!v.ok) return res.status(400).json({ error: v.errors.join("; ") });
  store.faq[idx] = updated;
  db.save();
  res.json(updated);
});

// DELETE /api/knowledge/faq/:id — remove an FAQ entry.
router.delete("/faq/:id", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const idx = store.faq.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "FAQ not found" });
  const [removed] = store.faq.splice(idx, 1);
  db.save();
  res.json({ ok: true, id: removed.id });
});

// GET /api/knowledge/params — all platform params (+ stale highlight info).
router.get("/params", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const list = store.platform_params.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const configRefs = {};
  ps.CONFIG_SPEC.forEach((s) => { configRefs[s.key] = s.ref; });
  res.json({ params: list, groups: km.PARAM_GROUPS, groupLabels: PARAM_GROUP_LABELS, configRefs });
});

// POST /api/knowledge/params/reconcile  { apply?: boolean }
// Dry-run diff by default (never writes); apply=true mutates + saves.
router.post("/params/reconcile", requireAuth, requireAdmin, (req, res) => {
  const apply = !!(req.body && req.body.apply);
  const report = ps.reconcileParams(persistedStore(db.get()), { dryRun: !apply });
  report.applyRun = apply;
  res.json({ report });
});

// POST /api/knowledge/params/apply  { key }
// Force-sync a single param from config (admin explicit action).
router.post("/params/apply", requireAuth, requireAdmin, (req, res) => {
  const key = String((req.body && req.body.key) || "").trim();
  if (!key) return res.status(400).json({ error: "key required" });
  const result = ps.applyConfigValue(persistedStore(db.get()), key);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// DELETE /api/knowledge/params/:key — remove a platform param entirely
// (manual cleanup / removing stale leftovers after a config deletion).
router.delete("/params/:key", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const key = String(req.params.key || "").trim();
  const idx = store.platform_params.findIndex((p) => p.key === key);
  if (idx === -1) return res.status(404).json({ error: "param not found" });
  const [removed] = store.platform_params.splice(idx, 1);
  db.save();
  res.json({ ok: true, key: removed.key });
});

// POST /api/knowledge/preview  { question }
// Lets the admin see how the actual AI assistant would answer a question,
// bypassing the subscription gate (admin feature). Once the assistant is
// wired to the knowledge base (section 6) this preview will include the
// retrieved FAQ/param context in the prompt.
router.post("/preview", requireAuth, requireAdmin, previewLimiter, async (req, res) => {
  const question = String((req.body && req.body.question) || "").trim().slice(0, 2000);
  if (!question) return res.status(400).json({ error: "question required" });
  try {
    const { manaraChat } = require("../ai/manaraChat");
    const result = await manaraChat({ message: question, history: [], user: req.user });
    return res.json(result);
  } catch (e) {
    console.error("[knowledge] preview failed:", e && e.message);
    return res.status(500).json({ error: "تعذر معالجة المعاينة حالياً — حاول لاحقاً" });
  }
});

// GET /api/knowledge/public?lang=ar|en — PUBLIC read for the AI assistant
// (and any external consumer: mobile app, docs, future public FAQ page).
// No auth. Returns active content only, never the internal params. The
// optional `lang` projects the bundle to a single clean language.
router.get("/public", (req, res) => {
  const lang = "ar" === String(req.query.lang) ? "ar" : ("en" === String(req.query.lang) ? "en" : null);
  res.json(buildKnowledgeBundle(db.get(), /* publicOnly */ true, lang));
});

// GET /api/knowledge/export — active, AI-ready content bundle (admin full view).
// Used by the assistant (later sections) and by the admin preview/export.
router.get("/export", requireAuth, requireAdmin, (req, res) => {
  res.json(buildKnowledgeBundle(db.get(), false));
});

module.exports = router;