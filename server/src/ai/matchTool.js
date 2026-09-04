/* ==========================================================================
   Manara AI Assistant — Smart Matching tool.
   Detects when a user is asking for PLAYER or CLUB recommendations inside the
   chat, extracts the relevant criteria (sport / position / country / level),
   runs the pure matching engine, and produces a concise Arabic reply.

   SECURITY / SEPARATION (do not regress):
   - This module does NOT touch the subscription engine. It only reads
     db.get() and calls the independent matching module. The surrounding chat
     endpoint (ai.routes.js) already applies requireActiveSub, so using the
     assistant can never bypass the paywall, and it can never leak private
     data (the route layer decides masking; here we only ever surface names /
     positions / clubs / countries — non-sensitive fields).
   ========================================================================== */
const db = require("../db");
const { matchPlayersForClub, matchClubsForPlayer, W } = require("../matching");
const su = require("../searchUtils");

// Intent + criteria detection. Returns null when the message is not a
// recommendation request.
function detectIntent(text) {
  const t = " " + su.norm(String(text || "")) + " ";
  const wantPlayer =
    /\b(لعب|لاعب|لاعبين|مهاجم|مدافع|حارس|جناح|وسط|صارم|هجوم|دفاع)\b/.test(t) ||
    /\b(player|players|striker|forward|defender|goalkeeper|wing|midfielder|guard|center|forward)\b/.test(t) ||
    /رش[حه][نيا]?.*(لعب|لاعب)/.test(t);
  const wantClub =
    /\b(نادي|ناد|انديه|اندية|اكاديميه|اكاديمية|فرق|فريق|club|clubs|academy|team)\b/.test(t) ||
    /رش[حه][ني]?.*(نادي|ناد|اكاديميه)/.test(t);

  const recommend = /\b(رشح|رشد|اقترح|اوجد|ابحث|ابحثي|ادلي|مطلوب|احتاج|انصح|recommend|suggest|find|looking|need|best|match|search|top)\b/.test(t) ||
    /رش[حه]/.test(t);

  if (!recommend && !wantPlayer && !wantClub) return null;

  // If both hints are ambiguous (e.g. "مهاجم" alone) default to players.
  const kind = (wantClub && !wantPlayer) ? "club" : "player";

  const criteria = extractCriteria(text);
  return { kind, criteria };
}

function extractCriteria(text) {
  const s = su.norm(String(text || ""));
  // Strip common Arabic connectors ("ال", "لل", "ل", "ف", "و", "ب", "ك", "ت")
  // from each word so "لكرة السلة" matches "كرة السلة", while a short bare
  // term like "يد" still never matches inside "السويد" (whole-word match).
  const cleanWord = (w) => {
    let x = w;
    const pre = ["ال", "لل", "ل", "ف", "و", "ب", "ك", "ت", "ول", "وال"];
    let moved = true;
    while (moved && x.length > 2) {
      moved = false;
      for (const p of pre) {
        if (x.length > p.length + 1 && x.indexOf(p) === 0) { x = x.slice(p.length); moved = true; break; }
      }
    }
    return x;
  };
  const strippedWords = s.split(" ").filter(Boolean).map(cleanWord);
  const joined = strippedWords.join(" ");

  const hasPhrase = (kw) => {
    const nw = su.norm(kw || "");
    if (!nw) return false;
    // Normalize the keyword through the same connector-stripping so phrases
    // like "كرة السلة" line up with the stripped message.
    const kwWords = nw.split(" ").filter(Boolean).map(cleanWord);
    const kwJoined = kwWords.join(" ");
    if (kwJoined.indexOf(" ") !== -1) return joined.indexOf(kwJoined) !== -1; // phrase
    if (kwJoined.length < 2) return false; // too short / connector-only
    return strippedWords.indexOf(kwJoined) !== -1; // bare token (whole word)
  };
  const c = {};

  // Position keywords (bilingual).
  const positionMap = {
    striker: ["st", "مهاجم", "راس حربه", "nine", "9"],
    winger: ["جناح", "wing", "lw", "rw"],
    midfielder: ["وسط", "midfielder", "mid", "playmaker", "صانع العاب", "ارتكاز"],
    defender: ["مدافع", "defender", "cb", "lb", "rb", "قلب الدفاع", "ظهير"],
    goalkeeper: ["حارس مرمى", "حارس", "goalkeeper", "gk"],
    guard: ["guard", "هجوم خلفي"],
    forward: ["فوروارد", "power forward", "pf"],
    setter: ["setter", "معده", "معد", "رافع"],
    outsideHitter: ["outside hitter"]
  };
  for (const key of Object.keys(positionMap)) {
    if (positionMap[key].some((p) => hasPhrase(p))) { c.position = key; break; }
  }

  // Sport detection (whole-word, so "يد" never matches inside "السويد").
  const sportMap = {
    "Football": ["football", "soccer", "كره قدم", "كرة القدم", "قدم"],
    "Basketball": ["basketball", "basket", "كره سله", "كرة السلة", "سله"],
    "Handball": ["handball", "كره يد", "كرة اليد"],
    "Volleyball": ["volleyball", "كره طائره", "الكرة الطائرة", "طائره"],
    "Tennis": ["tennis", "تنس"],
    "Swimming": ["swimming", "سباحه", "سباحة"],
    "Karate": ["karate", "كاراتيه"],
    "Golf": ["golf", "غولف"]
  };
  for (const key of Object.keys(sportMap)) {
    if (sportMap[key].some((p) => hasPhrase(p))) { c.sport = key; break; }
  }

  // Country (whole-word).
  const countryMap = {
    "Egypt": ["مصر", "egypt", "مصري"],
    "Saudi Arabia": ["سعوديه", "السعودية", "saudi"],
    "UAE": ["امارات", "الامارات", "uae", "emirates"],
    "Kuwait": ["كويت", "kuwait"],
    "Qatar": ["قطر", "qatar"],
    "Morocco": ["مغرب", "المغرب", "morocco"],
    "Algeria": ["جزائر", "الجزائر", "algeria"],
    "Tunisia": ["تونس", "tunisia"],
    "Spain": ["اسباني", "اسبانيا", "spain"],
    "England": ["انجلترا", "بريطانيا", "england", "uk"],
    "France": ["فرنسا", "france"],
    "Germany": ["المانيا", "ألمانيا", "germany"],
    "Sweden": ["السويد", "sweeden", "sweden"]
  };
  for (const key of Object.keys(countryMap)) {
    if (countryMap[key].some((p) => hasPhrase(p))) { c.country = key; break; }
  }

  // Level.
  if (/\b(محترف|احترافي|pro|professional|elite)\b/.test(s)) c.level = "Pro";
  else if (/semi.?pro|شبه محترف/.test(s)) c.level = "Semi-pro";
  else if (/\b(هواة|amateur|مبتدئ)\b/.test(s)) c.level = "Amateur";

  return c;
}

/* Run a recommendation based on intent + criteria. Returns a plain object
   { found: bool, summary: string, items: [...], config: {...} }.
   When nothing matches, found=false and the caller emits the "not found" reply. */
function runMatch(text) {
  const detected = detectIntent(text);
  if (!detected) return { recognized: false };

  const store = db.get() || {};
  const players = store.players || [];
  const clubs = store.clubs || [];
  const need = Object.assign(
    { sport: "", position: "", country: "", level: "" },
    detected.criteria
  );
  const approved = (p) => db.profileApproved(p);

  let items = [];
  if (detected.kind === "player") {
    items = matchPlayersForClub({
      players,
      approved,
      sport: need.sport,
      position: need.position,
      country: need.country,
      level: need.level,
      limit: 5
    }).map((m) => ({
      kind: "player",
      name: m.profile.name,
      position: m.profile.position,
      sport: m.profile.sport,
      country: m.profile.country,
      level: m.profile.level,
      score: m.score
    }));
  } else {
    items = matchClubsForPlayer({
      clubs,
      approved,
      sport: need.sport,
      position: need.position,
      country: need.country,
      level: need.level,
      limit: 5
    }).map((m) => ({
      kind: "club",
      name: m.profile.name,
      sport: m.profile.sport,
      country: m.profile.country,
      city: m.profile.city,
      level: m.profile.level,
      score: m.score
    }));
  }

  // A real match must exceed the pure "availability" bonus (5); a score equal
  // to that means the profile only matched on generic availability, not on any
  // of the explicit criteria (sport/position/level/country) the user asked for.
  const found = items.some((i) => i.score > W.availability);
  return {
    recognized: true,
    found,
    kind: detected.kind,
    criteria: detected.criteria,
    items: items.filter((i) => i.score > W.availability)
  };
}

function formatReply(res) {
  if (!res || !res.recognized) return null;
  if (!res.found || !res.items.length) {
    return {
      scope: "manara",
      provider: "matchTool",
      reply: "عذراً، الوصف غير موجود — لا توجد نتائج مطابقة للمواصفات التي طلبتها. جرّب تحديد الرياضة أو المركز أو الدولة بشكل أوضح."
    };
  }
  const label = res.kind === "player" ? "لاعبون مقترحون" : "أندية مقترحة";
  const lines = res.items.slice(0, 3).map((i, idx) => {
    const where = (i.country || i.city) ? " — " + (i.city || i.country) : "";
    const pos = i.position || i.sport;
    return (idx + 1) + ") " + (i.name || "—") + " (" + pos + ")" + where;
  });
  const extra = res.items.length > 3 ? "\n…و " + (res.items.length - 3) + " نتائج أخرى." : "";
  const reply =
    label + " حسب ما طلبته:\n" +
    lines.join("\n") + extra +
    "\n\nلاستعراض التفاصيل الكاملة (مع حماية الخصوصية)، انتقل إلى صفحة البحث أو اطلب من المساعد أن يبيّن لك المزيد.";
  return { scope: "manara", provider: "matchTool", reply };
}

module.exports = { detectIntent, extractCriteria, runMatch, formatReply };
