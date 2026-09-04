/* ==========================================================================
   Manara — Smart Matching engine (Phase 1, self-contained).
   A pure, dependency-free scoring/ranking layer for finding the best-fitting
   clubs for a player, and players for a club.

   DESIGN:
   - PURE and free of side effects: it NEVER mutates the passed-in profile
     objects and never attaches internal fields to them, so it is safe to call
     against the live db.get() store without polluting it (no extra fields
     that could leak into a db.save() global diff).
   - INPUT: the flat profile arrays + an `approved(profile) -> bool` predicate
     (plus the query/need). The caller (route layer) supplies the store data.
   - OUTPUT: array of ORIGINAL profile references augmented with a non-mutating
     score (returned inside a wrapper object { profile, score }).
   - The route layer decides which serialization (publicPlayer / maskPlayer /
     publicClub) to emit based on the viewer's role.

   SECURITY & SEPARATION (do not regress):
   - This module is INDEPENDENT of the subscription engine (requireSub /
     requireActiveSub). It never checks subscriptionStatus and never calls
     sub.hasAccess(). Gating is handled only by the route layer via requireAuth
     + per-role output masking — the matching feature can never be used to
     bypass the paywall or leak private data.
   ========================================================================== */
const su = require("./searchUtils");

// Field weights for exact/categorical matches. Higher = more important.
const W = {
  sport: 30,        // same sport is the dominant signal
  position: 25,     // position vs neededPosition
  level: 10,        // pro / semi-pro ...
  geo: 8,           // same country or city
  availability: 5,  // available = true bonus (players)
  text: 1           // semantic/token similarity weight
};

function tokensOf(...parts) {
  const text = parts.filter(Boolean).join(" ");
  return su.norm(text).split(" ").filter(Boolean);
}

// ---- IDF over a candidate set, so common words carry less weight ---------
function computeIdf(tokenSets) {
  const df = new Map();
  let n = 0;
  for (const set of tokenSets) {
    if (!set || !set.size) continue;
    n++;
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  df.forEach((count, t) => { idf.set(t, Math.log((n + 1) / (count + 1)) + 1); });
  return idf;
}

// ---- Cosine similarity between two TF-IDF term vectors -------------------
function toVec(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function cosine(aTokens, bTokens, idf) {
  const aVec = toVec(aTokens);
  const bVec = toVec(bTokens);
  let dot = 0, aNorm = 0, bNorm = 0;
  for (const [t, tf] of aVec) {
    const w = (idf && idf.get(t)) || 1;
    const av = tf * w;
    const bv = (bVec.get(t) || 0) * w;
    dot += av * bv;
    aNorm += av * av;
  }
  for (const [t, tf] of bVec) {
    const w = (idf && idf.get(t)) || 1;
    const bv = tf * w;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function synonymMatch(leftHay, rightValue) {
  const q = su.expandQuery(String(rightValue || ""));
  return su.match(su.wrap(String(leftHay || "")), q);
}

// Cleanable text signature from a profile for semantic overlap.
function profileText(profile) {
  return [
    profile && profile.name,
    profile && profile.bio,
    profile && profile.stats,
    profile && profile.keywords,
    profile && profile.sport,
    profile && profile.position,
    profile && profile.neededPosition
  ].filter(Boolean).join(" ");
}

/* Core scorer: how well `profile` satisfies `need`.
   `profileKind` = "player" | "club" (only affects the availability bonus). */
function scoreNeedAgainstProfile(need, profile, profileKind) {
  let score = 0;

  if (need.sport && profile && profile.sport) {
    if (synonymMatch(profile.sport, need.sport)) score += W.sport;
  }

  // Position vs neededPosition (and the reverse, for safety).
  const pA = (need && need.position) || "";
  const pB = (profile && profile.position) || (profile && profile.neededPosition) || "";
  if (pA && pB) {
    if (synonymMatch(pB, pA) || synonymMatch(pA, pB)) score += W.position;
  }

  const needLvl = su.norm((need && need.level) || "");
  const profLvl = su.norm((profile && profile.level) || "");
  if (needLvl && profLvl && needLvl === profLvl) score += W.level;

  const needCountry = su.norm((need && need.country) || "");
  const profCountry = su.norm((profile && profile.country) || "");
  if (needCountry && profCountry && needCountry === profCountry) score += W.geo;
  const needCity = su.norm((need && need.city) || "");
  const profCity = su.norm((profile && profile.city) || "");
  if (needCity && profCity && needCity === profCity) score += W.geo;

  if (profileKind === "player" && profile && profile.available === true) score += W.availability;

  // Semantic (token) similarity over the free-text fields.
  const hayA = profileText(profile);
  const hayB = profileText(need) || [need && need.sport, need && need.position, need && need.text].filter(Boolean).join(" ");
  const toksA = tokensOf(hayA);
  const toksB = tokensOf(hayB);
  if (toksA.length && toksB.length) {
    const idf = computeIdf([new Set(toksA), new Set(toksB)]);
    score += W.text * cosine(toksA, toksB, idf) * 10;
  }

  return Math.round(score * 100) / 100;
}

/* --------------------------------------------------------------------------
   Club -> players : rank players for a club's needs.
   args: { players: [...], approved(player)->bool, sport, position, country,
          city, text (free search), limit }
   Returns [{ profile, score }] sorted desc by score.
   ------------------------------------------------------------------------- */
function matchPlayersForClub(args) {
  const players = (args && args.players) || [];
  const approved = (args && args.approved) || (() => true);
  const need = {
    sport: (args && args.sport) || "",
    position: (args && args.position) || (args && args.neededPosition) || "",
    country: (args && args.country) || "",
    city: (args && args.city) || "",
    level: (args && args.level) || "",
    text: (args && args.text) || ""
  };
  const scored = [];
  for (const p of players) {
    if (!p || !p.userId || !approved(p)) continue;
    scored.push({ profile: p, score: scoreNeedAgainstProfile(need, p, "player") });
  }
  return rank(scored, args && args.limit);
}

/* --------------------------------------------------------------------------
   Player -> clubs : rank clubs for a player's needs.
   args: { clubs: [...], approved(club)->bool, sport, position, country, level,
          text, limit }
   ------------------------------------------------------------------------- */
function matchClubsForPlayer(args) {
  const clubs = (args && args.clubs) || [];
  const approved = (args && args.approved) || (() => true);
  const need = {
    sport: (args && args.sport) || "",
    position: (args && args.position) || (args && args.neededPosition) || "",
    country: (args && args.country) || "",
    city: (args && args.city) || "",
    level: (args && args.level) || "",
    text: (args && args.text) || ""
  };
  const scored = [];
  for (const c of clubs) {
    if (!c || !c.userId || !approved(c)) continue;
    scored.push({ profile: c, score: scoreNeedAgainstProfile(need, c, "club") });
  }
  return rank(scored, args && args.limit);
}

function rank(scored, limit) {
  const sorted = scored.slice().sort((a, b) => b.score - a.score);
  const out = limit ? sorted.slice(0, limit) : sorted;
  return out.map((x) => ({ profile: x.profile, score: x.score }));
}

module.exports = {
  matchPlayersForClub,
  matchClubsForPlayer,
  scoreNeedAgainstProfile,
  cosine,
  tokensOf,
  profileText,
  W
};
