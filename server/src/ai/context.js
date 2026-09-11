/* ==========================================================================
   Section 5 — Ingestion + RAG-lite for the AI assistant.
   There is NO external vector DB and NO model involved in retrieval: we
   ingest the platform's OWN knowledge (active FAQ entries + active platform
   params from the live store) and score them by simple keyword overlap, so
   the assistant answers strictly from verified content.

     - ingestStore(store, opts)  : active-only, lang-aware (ar/en) entries.
     - searchEntries(...)        : model-free keyword match over the base.
     - buildContext(query, opts) : top 3-5 answers + relevant params + a
                                   ready-to-inject context string.

   Static defaults (server/src/ai/knowledgeBase.js) are used ONLY as a
   fallback when the admin hasn't populated the DB yet, so the assistant
   keeps answering offline with the same grounded facts as before.
   ========================================================================== */
const km = require("../knowledge");
const db = require("../db");
const knowledgeBase = require("./knowledgeBase");
const { tokenize } = require("./retrieve");

const DEFAULT_K = 5;
const MIN_K = 1;
const MAX_K = 6;

function clampK(kRaw) {
  const n = Number(kRaw);
  const v = kRaw !== undefined && kRaw !== null && Number.isFinite(n) ? n : DEFAULT_K;
  return Math.min(MAX_K, Math.max(MIN_K, v));
}

// Effective display value: when a param is flagged stale we prefer what the
// CONFIG source says now (configValue) over the possibly-outdated stored one.
function effectiveValue(p) {
  if (p && p.stale === true && p.configValue !== null && p.configValue !== undefined) return p.configValue;
  return p ? p.value : null;
}

function faqEntry(f) {
  const q = f.question || {};
  const a = f.answer || {};
  const textAr = [q.ar || q.en || "", a.ar || a.en || ""].filter(Boolean).join("\n");
  const textEn = [q.en || q.ar || "", a.en || a.ar || ""].filter(Boolean).join("\n");
  return {
    kind: "faq",
    id: "faq:" + f.id,
    faqId: f.id,
    category: f.category,
    priority: f.priority || 0,
    question: q,
    answer: a,
    textAr,
    textEn,
    scoringText: textAr + " " + textEn + " " + (Array.isArray(f.keywords) ? f.keywords : [String(f.keywords || "")]).join(" ")
  };
}

function paramEntry(p) {
  const label = p.label || {};
  const v = effectiveValue(p);
  const disp = km.displayParamValue(v);
  const lineAr = (label.ar || p.key) + ": " + disp;
  const lineEn = (label.en || p.key) + ": " + disp;
  return {
    kind: "param",
    id: "prm:" + p.key,
    key: p.key,
    group: p.group,
    label: label,
    value: v,
    stale: p.stale === true,
    lineAr,
    lineEn,
    scoringText: lineAr + " " + lineEn + " " + p.key
  };
}

const STATIC_DEFAULTS = knowledgeBase.KNOWLEDGE_BASE.map((e) => ({
  kind: "serial",
  id: "serial:" + e.id,
  category: e.topic,
  textAr: e.text,
  textEn: e.text,
  scoringText: e.text
}));

/* Ingestion: active FAQ + active params → normalized lang-aware entries.
   Returns { entries, usedDefaults } — usedDefaults is true when the DB base
   is empty and the static defaults were merged in. */
function ingestStore(store, opts) {
  const s = (store || (db.get && db.get())) || { faq: [], platform_params: [] };
  const lang = opts && opts.lang === "en" ? "en" : "ar";
  const entries = [];
  let usedDefaults = false;

  const faqs = km.activeFaqs(s.faq);
  const params = km.activeParams(s.platform_params);

  if (faqs.length) entries.push(...faqs.map(faqEntry));
  if (params.length) entries.push(...params.map(paramEntry));

  // No user-curated content yet → keep the historical static base working.
  if (!entries.length && (opts && opts.withDefaults !== false)) {
    entries.push(...STATIC_DEFAULTS);
    usedDefaults = true;
  }

  return { entries, usedDefaults, lang };
}

function scoreEntry(entry, qTokens) {
  const chunkTokens = tokenize(entry.scoringText);
  const set = new Set(chunkTokens);
  let score = 0;
  for (const t of qTokens) {
    if (set.has(t)) score += 2;
  }
  // Exact tokens won the round; if nothing matched exactly, allow one
  // substring overlap per long token (derived morphologies, transliteration).
  if (score === 0) {
    for (const t of qTokens) {
      if (t.length >= 4 && chunkTokens.some((c) => c.includes(t) || t.includes(c))) { score += 1; break; }
    }
  }
  return score;
}

/* Model-free search: keyword overlap between the query and each entry.
   Honors opts.k (clamp 1..6) and opts.only ("faq" | "param"). */
function searchEntries(entries, query, opts) {
  const k = clampK(opts && opts.k);
  const only = opts && opts.only;
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  return entries
    .filter((e) => !only || e.kind === only)
    .map((e) => ({ entry: e, score: scoreEntry(e, qTokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.entry.priority || 0) - (a.entry.priority || 0))
    .slice(0, k);
}

function pickLang(lang, ar, en) {
  if (lang === "en" && en) return en;
  if (lang === "ar" && ar) return ar;
  return ar || en || "";
}

function renderEntry(e, lang) {
  if (e.kind === "faq") {
    const q = pickLang(lang, e.question.ar, e.question.en);
    const a = pickLang(lang, e.answer.ar, e.answer.en);
    return "س: " + q + "\nج: " + a;
  }
  if (e.kind === "param") {
    const lab = (e.label && e.label[lang]) || (e.label && e.label.ar) || (e.label && e.label.en) || e.key;
    return lab + ": " + km.displayParamValue(e.value);
  }
  return e.scoringText;
}

/* The RAG query -> full, LLM-ready context.
   Returns { query, lang, k, usedDefaults, faqs, params, context }.
   - faqs  : the top matching question/answer pairs (bilingual objects).
   - params: the relevant platform params (key, label, value).
   - context: combined string for injection into the system prompt. */
function buildContext(query, opts) {
  const lang = opts && opts.lang === "en" ? "en" : "ar";
  const k = clampK(opts && opts.k);
  const store = opts && opts.store ? opts.store : db.get();
  const ingest = ingestStore(store, { lang });
  const matches = searchEntries(ingest.entries, String(query || ""), { k, only: opts && opts.only });

  const faqs = matches.filter((m) => m.entry.kind === "faq").map((m) => ({
    id: m.entry.faqId || m.entry.id,
    category: m.entry.category,
    score: m.score,
    question: m.entry.question,
    answer: m.entry.answer,
    priority: m.entry.priority
  }));

  const params = matches.filter((m) => m.entry.kind === "param").map((m) => ({
    key: m.entry.key,
    group: m.entry.group,
    score: m.score,
    label: m.entry.label,
    value: m.entry.value,
    display: km.displayParamValue(m.entry.value)
  }));

  const context = matches.map((m) => renderEntry(m.entry, lang)).join("\n\n");

  return {
    query: String(query || ""),
    lang,
    k,
    usedDefaults: ingest.usedDefaults,
    faqs,
    params,
    context
  };
}

module.exports = { buildContext, ingestStore, searchEntries, faqEntry, paramEntry, effectiveValue };