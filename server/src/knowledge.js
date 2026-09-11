/* ==========================================================================
   Knowledge data model for the AI assistant (sections 1 + 2 of the plan).
   Two collections live in the store:
     - faq             : structured question/answer entries (bilingual,
                         Arabic + English) tagged with a category and baked
                         search keywords for retrieval later (section 5/RAG).
     - platform_params : platform parameters that are sourced either
                         automatically from ./config (source:"auto-config")
                         or typed by an admin (source:"manual").

   The module is DB-agnostic: factories accept an optional `nextId`
   function (db.nextId) and never read the store themselves, so they stay
   pure and unit-testable offline.
   ========================================================================== */

const helpers = require("./helpers");
const sanitizeHtml = require("sanitize-html");

// Text-only sanitization for admin-authored content (fields 7 of the plan):
// strips any HTML tags/attributes/schemes, drops control + null bytes, trims,
// and caps the length. All FAQ/param text passes through this at the model
// layer, so every write path (routes, reconcile, future ones) is covered.
// Rendering still escapes (esc()/textContent in the UI), so even if raw HTML
// ever survived it could not execute in the browser or be injected into the
// assistant prompt.
const TEXT_ONLY = { allowedTags: [], allowedAttributes: {}, allowedSchemes: [] };
function cleanText(value, max) {
  if (value === undefined || value === null) return "";
  const raw = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  let s = sanitizeHtml(raw, TEXT_ONLY).trim();
  if (max > 0 && s.length > max) s = s.slice(0, max);
  return s;
}

const FAQ_CATEGORIES = [
  "general",
  "registration",
  "verification",
  "login",
  "billing",
  "payment",
  "profile",
  "features",
  "ai_assistant"
];

const PARAM_GROUPS = [
  "billing",
  "trial",
  "payment",
  "upload",
  "registration",
  "general"
];

const PARAM_TYPES = ["number", "string", "boolean", "array"];

/* Content length ceilings (defense in depth: also limit prompt size / abuse).
   Answers are the longest field, questions short, keys/labels short. */
const MAX_QUESTION = 2000;
const MAX_ANSWER = 20000;
const MAX_SOURCE = 500;
const MAX_LABEL = 300;
const MAX_KEY = 200;
const MAX_KEYWORDS = 5000;
const MAX_PARAM_STR_VALUE = 2000;
const MAX_PARAM_ARRAY = 100;
const MAX_PRIORITY = 1000;

/* ---- small helpers ----------------------------------------------------- */

function isBlank(s) {
  return s === undefined || s === null || String(s).trim() === "";
}

/* Best-effort JSON type (Db stores what routes give us; the type tag is
   inferred by default so it can never drift from the actual value). */
function inferType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined) return "string";
  return typeof value; // "number" | "string" | "boolean"
}

/* id = prefix + nextId("collection") when a counter is provided (db.nextId),
   otherwise a random hex so the factories stay usable standalone. */
function genId(nextId, collection, prefix) {
  if (typeof nextId === "function") return prefix + nextId(collection);
  return prefix + Math.random().toString(36).slice(2, 10);
}

function trimText(value) {
  return String(value == null ? "" : value).trim();
}

/* Human/LLM display form of a param value: arrays join, booleans as
   "true"/"false", numbers/strings as-is. */
function displayParamValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (value === undefined) return "";
  return String(value);
}

/* ---- FAQ model --------------------------------------------------------- */

function bakeFaqKeywords(question, extra) {
  return helpers.buildKeywords([
    (question && question.ar) || "",
    (question && question.en) || "",
    extra || ""
  ]);
}

// Create a normalized FAQ document. `input.question` / `input.answer` may be
// full {ar,en} objects or plain strings (treated as Arabic fill-in).
function newFaq(input, nextId) {
  const i = input || {};
  const now = new Date().toISOString();
  const qIn = i.question || {};
  const aIn = i.answer || {};
  const qAr = isBlank(i.questionAr) ? cleanText(qIn.ar, MAX_QUESTION) : cleanText(i.questionAr, MAX_QUESTION);
  const qEn = isBlank(i.questionEn) ? cleanText(qIn.en, MAX_QUESTION) : cleanText(i.questionEn, MAX_QUESTION);
  const aAr = isBlank(i.answerAr) ? cleanText(aIn.ar, MAX_ANSWER) : cleanText(i.answerAr, MAX_ANSWER);
  const aEn = isBlank(i.answerEn) ? cleanText(aIn.en, MAX_ANSWER) : cleanText(i.answerEn, MAX_ANSWER);

  const doc = {
    id: i.id || genId(nextId, "faq", "faq_"),
    category: FAQ_CATEGORIES.indexOf(i.category) !== -1 ? i.category : "general",
    question: { ar: qAr, en: qEn },
    answer: { ar: aAr, en: aEn },
    keywords: bakeFaqKeywords({ ar: qAr, en: qEn }, typeof i.keywords === "string" ? cleanText(i.keywords, MAX_KEYWORDS) : i.keywords),
    source: cleanText(i.source, MAX_SOURCE),
    isActive: i.isActive !== false,
    priority: clampPriority(i.priority),
    createdBy: cleanText(i.createdBy, 200) || "system",
    createdAt: i.createdAt || now,
    updatedAt: i.createdAt || now
  };
  return doc;
}

function validateFaq(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") return { ok: false, errors: ["faq object required"] };
  const q = doc.question || {};
  const a = doc.answer || {};
  if (isBlank(q.ar) && isBlank(q.en)) errors.push("question required in ar or en");
  if (isBlank(a.ar) && isBlank(a.en)) errors.push("answer required in ar or en");
  if (doc.category && FAQ_CATEGORIES.indexOf(doc.category) === -1) {
    errors.push("invalid category: " + doc.category);
  }
  return { ok: errors.length === 0, errors };
}

const FAQ_EDITABLE = ["category", "keywords", "source", "isActive", "priority", "createdBy"];

function clampPriority(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_PRIORITY, n));
}

// Apply a partial patch onto a FAQ doc, re-baking keywords when the question
// changes, always refreshing updatedAt, and re-sanitizing text fields.
// Returns a NEW object (does not mutate the original).
function updateFaq(doc, patch) {
  const p = patch || {};
  const next = Object.assign({}, doc, {
    question: Object.assign({ ar: "", en: "" }, doc.question || {}, p.question || {}),
    answer: Object.assign({ ar: "", en: "" }, doc.answer || {}, p.answer || {})
  });
  next.question.ar = cleanText(next.question.ar, MAX_QUESTION);
  next.question.en = cleanText(next.question.en, MAX_QUESTION);
  next.answer.ar = cleanText(next.answer.ar, MAX_ANSWER);
  next.answer.en = cleanText(next.answer.en, MAX_ANSWER);
  FAQ_EDITABLE.forEach((k) => {
    if (p[k] !== undefined) next[k] = p[k];
  });
  if (p.keywords !== undefined) {
    next.keywords = typeof p.keywords === "string" ? cleanText(p.keywords, MAX_KEYWORDS) : bakeFaqKeywords(next.question, p.keywords);
  } else if (p.question) {
    next.keywords = bakeFaqKeywords(next.question, doc.keywords);
  }
  if (p.category !== undefined && FAQ_CATEGORIES.indexOf(next.category) === -1) {
    next.category = "general";
  }
  next.source = cleanText(next.source, MAX_SOURCE);
  if (p.priority !== undefined) next.priority = clampPriority(p.priority);
  next.createdBy = cleanText(next.createdBy, 200) || "system";
  next.updatedAt = new Date().toISOString();
  return next;
}

// Only the published entries (used to build the AI context and public export).
function activeFaqs(list) {
  return (Array.isArray(list) ? list : []).filter((f) => f && f.isActive !== false);
}

/* ---- platform params model --------------------------------------------- */

// Create a normalized platform parameter document. `value` may be any JSON
// value; a falsy-but-valid value (0 / false / "") is preserved as-is.
function newPlatformParam(input, nextId) {
  const i = input || {};
  const now = new Date().toISOString();
  const lIn = i.label || {};
  const lAr = isBlank(i.labelAr) ? cleanText(lIn.ar, MAX_LABEL) : cleanText(i.labelAr, MAX_LABEL);
  const lEn = isBlank(i.labelEn) ? cleanText(lIn.en, MAX_LABEL) : cleanText(i.labelEn, MAX_LABEL);

  const doc = {
    id: i.id || genId(nextId, "platform_param", "prm_"),
    key: cleanText(i.key, MAX_KEY),
    group: PARAM_GROUPS.indexOf(i.group) !== -1 ? i.group : "general",
    label: { ar: lAr, en: lEn },
    value: normalizeValue(i.value), // intentional: may be 0 / false / ""
    type: PARAM_TYPES.indexOf(i.type) !== -1 ? i.type : inferType(i.value),
    source: i.source === "auto-config" ? "auto-config" : "manual",
    configRef: cleanText(i.configRef, 200), // e.g. "PRICES.gamer" when auto-config
    active: i.active !== false,
    createdAt: i.createdAt || now,
    updatedAt: i.createdAt || now
  };
  return doc;
}

// Keep param values small + flat: scalars, or a flat array of scalars.
// Objects/oversized arrays/overlong strings are clamped (never rejected
// silently in a way that could break the admin UI — they stay as-is above the
// ceiling, and validatePlatformParam flags oversized ones on write).
function normalizeValue(value) {
  if (typeof value === "string") return cleanText(value, MAX_PARAM_STR_VALUE);
  if (Array.isArray(value)) return value.slice(0, MAX_PARAM_ARRAY).map((v) => (typeof v === "string" ? cleanText(v, MAX_PARAM_STR_VALUE) : v));
  return value;
}

const PARAM_KEY_RE = /^[a-z][a-z0-9_.-]*$/;

function validatePlatformParam(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") return { ok: false, errors: ["platform param object required"] };
  if (!isBlank(doc.key)) {
    if (!PARAM_KEY_RE.test(doc.key)) errors.push("invalid key: " + doc.key);
  } else {
    errors.push("key required");
  }
  const l = doc.label || {};
  if (isBlank(l.ar) && isBlank(l.en)) errors.push("label required in ar or en");
  if (doc.value === undefined) errors.push("value required");
  else if (typeof doc.value === "object" && !Array.isArray(doc.value)) errors.push("value must be a scalar or a flat array");
  else if (Array.isArray(doc.value) && doc.value.length > MAX_PARAM_ARRAY) errors.push("value array too large");
  else if (typeof doc.value === "string" && doc.value.length > MAX_PARAM_STR_VALUE) errors.push("value too long");
  if (doc.group && PARAM_GROUPS.indexOf(doc.group) === -1) errors.push("invalid group: " + doc.group);
  return { ok: errors.length === 0, errors };
}

const PARAM_EDITABLE = ["key", "group", "label", "value", "source", "configRef", "active"];

// Apply a partial patch, re-inferring type on value change and refreshing
// updatedAt. Key changes propagate to configRef nothing (that is the route
// layer's concern). text fields are re-sanitized. Returns a NEW object.
function updatePlatformParam(doc, patch) {
  const p = patch || {};
  const next = Object.assign({}, doc, {
    label: Object.assign({ ar: "", en: "" }, doc.label || {}, p.label || {})
  });
  next.label.ar = cleanText(next.label.ar, MAX_LABEL);
  next.label.en = cleanText(next.label.en, MAX_LABEL);
  PARAM_EDITABLE.forEach((k) => {
    if (k !== "label" && p[k] !== undefined) next[k] = p[k];
  });
  if (p.value !== undefined) {
    next.value = normalizeValue(p.value);
    next.type = PARAM_TYPES.indexOf(p.type) !== -1 ? p.type : inferType(next.value);
  }
  if (p.key !== undefined) next.key = cleanText(next.key, MAX_KEY);
  if (p.key !== undefined && !PARAM_KEY_RE.test(next.key)) {
    next.key = p.key ? String(p.key).trim() : ""; // keep the raw value so validate reports it
  }
  if (p.group !== undefined && PARAM_GROUPS.indexOf(next.group) === -1) next.group = "general";
  next.source = next.source === "auto-config" ? "auto-config" : "manual";
  next.configRef = cleanText(next.configRef, 200);
  next.updatedAt = new Date().toISOString();
  return next;
}

// Only the active params (used for the AI context and public export).
function activeParams(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && p.active !== false);
}

// `key` uniqueness is enforced by the route layer (needs the live store);
// this helper lets both the route and tests share the same lookup logic.
function findParamByKey(list, key, exceptId) {
  const arr = Array.isArray(list) ? list : [];
  if (isBlank(key)) return null;
  return arr.find((p) => p && p.key === key && (!exceptId || p.id !== exceptId)) || null;
}

/* ---- serialization ----------------------------------------------------- */

// Public copy of a FAQ doc (admin UI + export). Question/answer are kept
// bilingual; internal fields are callers' choice.
function publicFaq(doc) {
  if (!doc) return null;
  return Object.assign({}, doc);
}

// The context line fed to the AI for one param: "key = displayValue".
function paramContextLine(param, lang) {
  if (!param) return "";
  return param.key + " = " + displayParamValue(param.value) +
    (lang === "en" && param.label.en ? "  // " + param.label.en : "");
}

module.exports = {
  FAQ_CATEGORIES,
  PARAM_GROUPS,
  PARAM_TYPES,
  inferType,
  cleanText,
  displayParamValue,
  newFaq,
  validateFaq,
  updateFaq,
  activeFaqs,
  newPlatformParam,
  validatePlatformParam,
  updatePlatformParam,
  activeParams,
  findParamByKey,
  publicFaq,
  paramContextLine
};