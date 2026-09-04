// Shared search utilities: Arabic-aware normalization + bilingual
// (Arabic <-> English) sports dictionary + token-based AND matching.
const fs = require("fs");
const path = require("path");

// Load the dictionary so it stays editable without touching logic.
const DICT = JSON.parse(fs.readFileSync(path.join(__dirname, "search-dictionary.json"), "utf8"));

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u0640]/g, "")                 // tatweel
    .replace(/[\u064B-\u0652\u0670]/g, "")    // harakat
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Equivalence classes. Multi-word members are dissolved into their single
// words so substring matching stays word-based.
function dissolve(g) {
  const set = new Set();
  g.forEach((m) => String(m || "").split(/\s+/).forEach((w) => { const n = normText(w); if (n) set.add(n); }));
  return [...set];
}
const GROUPS_ORIGINAL = DICT.groups.map(dissolve);
const GROUPS = GROUPS_ORIGINAL.map((m) => m.slice());

// Bridge words that belong to several sports groups AND are short (<=4
// chars, e.g. bare كره shared by football/basketball/handball/volleyball) are
// removed from ALL groups: they cause cross-sport leakage while adding
// little search value. Longer shared words (محترف inside محترف/شبه محترف)
// are kept — those collisions are handled via phrase pinning instead.
const BRIDGE_COUNT = new Map();
(function dropBridgeWords() {
  GROUPS_ORIGINAL.forEach((members) => members.forEach((m) => BRIDGE_COUNT.set(m, (BRIDGE_COUNT.get(m) || 0) + 1)));
  for (let i = 0; i < GROUPS.length; i++) {
    const keep = GROUPS[i].filter((m) => BRIDGE_COUNT.get(m) === 1 || m.length > 4);
    if (keep.length >= 2) GROUPS[i] = keep;
  }
})();

// Words dropped as short bridges still need lookup fallback: they expand to
// the UNION of their original groups (ambiguous input -> broad results).
const ORIG_WORD_GROUPS = new Map();
GROUPS_ORIGINAL.forEach((members) => members.forEach((m) => {
  const arr = ORIG_WORD_GROUPS.get(m) || [];
  arr.push(members);
  ORIG_WORD_GROUPS.set(m, arr);
}));

const WORD_TO_GROUP = new Map();
GROUPS.forEach((members) => members.forEach((m) => {
  const arr = WORD_TO_GROUP.get(m) || [];
  arr.push(members);
  WORD_TO_GROUP.set(m, arr);
}));

// Phrases are resolved against the PRE-FILTER groups (phrase values like
// "كرة القدم" legitimately contain the shared word كره), but pin to the
// filtered member list so no bridge word leaks into query expansion.
function resolvePhrase(valueStr) {
  const words = normText(valueStr).split(" ").filter(Boolean);
  for (let i = 0; i < GROUPS_ORIGINAL.length; i++) {
    const orig = GROUPS_ORIGINAL[i];
    if (!words.length || !words.every((w) => orig.indexOf(w) !== -1)) continue;
    // Pinned synonyms: only words unique to this group (bridge words like
    // bare تنس shared with تنس الطاولة stay out of the expansion).
    const specific = GROUPS[i].filter((m) => BRIDGE_COUNT.get(m) === 1);
    const canon = (specific[0] || GROUPS[i][0] || words[0]);
    const g = new Set(specific);
    g.add(canon);
    return { t: canon, g: [...g], raw: words };
  }
  return null;
}
// "ال" definite-article flexibility: keys are stored both as-written and
// article-stripped so كرة السلة / كرة سلة variants all resolve.
const stripAl = (w) => (w.length > 3 && w.indexOf("ال") === 0 ? w.slice(2) : w);
const PHRASES = new Map();
Object.entries(DICT.phrases || {}).forEach(([k, v]) => {
  const val = resolvePhrase(v);
  if (!val) return;
  const nk = normText(k);
  const words = nk.split(" ").filter(Boolean);
  PHRASES.set(nk, val);
  const stripped = words.map(stripAl).join(" ");
  if (stripped !== nk) PHRASES.set(stripped, val);
});

// Short codes (gk, st, cb...) must match WHOLE words only, never substrings.
function hayHit(hay, t) {
  if (t.length <= 3) return hay.indexOf(" " + t + " ") !== -1;
  return hay.indexOf(t) !== -1;
}

// Normalize -> merge known phrases -> token list. Each token:
//   plain word  -> { t: word,        g: null,      raw: [word] }
//   phrase hit  -> { t: canonical,   g: members,   raw: phrase words }
function tokens(text) {
  const words = normText(text).split(" ").filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let ph, consumed2 = false;
    if (i + 1 < words.length) {
      ph = PHRASES.get(words[i] + " " + words[i + 1]);
      if (!ph) ph = PHRASES.get(stripAl(words[i]) + " " + stripAl(words[i + 1]));
      if (ph) consumed2 = true;
    }
    if (!ph) ph = PHRASES.get(words[i]); // single-word pins (e.g. تنس)
    if (ph && ph.g) { out.push(ph); if (consumed2) i++; continue; }
    out.push({ t: words[i], g: null, raw: [words[i]] });
  }
  return out;
}

// Query expansion: plain tokens union ALL groups containing them; phrase
// tokens stay pinned to their own group only.
function expandQuery(q) {
  return tokens(q).map((tok) => {
    const set = new Set([tok.t]);
    if (tok.g) tok.g.forEach((m) => set.add(m));
    else {
      const groups = WORD_TO_GROUP.get(tok.t) || ORIG_WORD_GROUPS.get(tok.t) || [];
      groups.forEach((g) => g.forEach((m) => set.add(m)));
    }
    return set;
  });
}

function wrap(s) { return " " + normText(s) + " "; }

// AND-match: EVERY expanded query token must hit.
function match(hayWrapped, expandedTokens) {
  if (!expandedTokens || !expandedTokens.length) return true;
  return expandedTokens.every((set) => {
    for (const t of set) if (hayHit(hayWrapped, t)) return true;
    return false;
  });
}

// Relevance score: matched query tokens weighted by field importance.
function score(expandedTokens, fields) {
  let total = 0;
  const hays = [
    [wrap(fields.name), 3],
    [wrap(fields.position), 2],
    [wrap(fields.keywords), 1.5],
    [wrap(fields.rest), 1]
  ];
  expandedTokens.forEach((set) => {
    for (const [hay, weight] of hays) {
      let hit = false;
      for (const t of set) { if (hayHit(hay, t)) { hit = true; break; } }
      if (hit) { total += weight; break; }
    }
  });
  return total;
}

// Baked keyword string for storage: token itself + its raw source words +
// synonyms from its pinned group (or ALL groups for plain words), deduped.
// Keeps legacy plain-substring clients working.
function bakeKeywords(text) {
  const seen = new Set();
  const out = [];
  const push = (w) => { if (w && !seen.has(w)) { seen.add(w); out.push(w); } };
  tokens(text).forEach((tok) => {
    push(tok.t);
    tok.raw.forEach(push);
    if (tok.g) tok.g.forEach(push);
    else (WORD_TO_GROUP.get(tok.t) || []).forEach((g) => g.forEach(push));
  });
  return out.join(" ");
}

module.exports = { norm: normText, tokens, expandQuery, wrap, match, score, bakeKeywords };
