/* ==========================================================================
   Manara AI Assistant — lightweight retrieval (RAG-lite).
   No external vector DB: we score knowledge-base chunks by keyword overlap
   against the user's question and return the top-k most relevant chunks.
   This keeps the dependency surface minimal while grounding the model in
   real, project-derived facts only.
   ========================================================================== */
const { getKnowledgeBase } = require("./knowledgeBase");

// Tiny Arabic/English stopword list so short common words don't dominate.
const STOP = new Set([
  "في", "من", "على", "إلى", "عن", "مع", "هل", "كيف", "ما", "لماذا", "أين", "متى",
  "و", "أو", "أن", "ان", "انه", "انها", "this", "the", "a", "an", "is", "are",
  "do", "does", "can", "i", "my", "me", "you", "we", "how", "what", "why", "where"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ـ_]/g, "") // strip Arabic tatweel / underscores
    .split(/[^ء-يa-z0-9أ-ي]+/i)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function scoreChunk(queryTokens, chunk) {
  const chunkTokens = tokenize(chunk);
  const set = new Set(chunkTokens);
  let score = 0;
  for (const t of queryTokens) {
    if (set.has(t)) score += 2;
    else if (chunkTokens.some((c) => c.includes(t) && t.length >= 4)) score += 1;
  }
  return score;
}

// Returns up to `k` relevant knowledge-base entries as plain text.
function retrieve(query, k) {
  k = k || 4;
  const qTokens = tokenize(query);
  const base = getKnowledgeBase();
  const scored = base
    .map((entry) => ({ entry, score: scoreChunk(qTokens, entry.text + " " + entry.topic) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k).map((x) => x.entry);
  // Always include the intro chunk as fallback context if nothing matched.
  if (top.length === 0) {
    const intro = base.find((e) => e.id === "intro");
    if (intro) top.push(intro);
  }
  return top.map((e) => e.text);
}

module.exports = { retrieve, tokenize };
