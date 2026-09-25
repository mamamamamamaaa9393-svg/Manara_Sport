/* Shared helpers: Arabic <-> English sport names, field mapping for the
   registration forms (which submit Arabic labels). */
const SPORT_MAP = {
  "كرة القدم": "Football",
  "كرة السلة": "Basketball",
  "التنس": "Tennis",
  "الكرة الطائرة": "Volleyball",
  "كرة اليد": "Handball",
  "الجولف": "Golf",
  "الكاراتيه": "Karate",
  "السباحة": "Swimming",
  "متعدد الرياضات": "Multi-sport",
  football: "Football",
  basketball: "Basketball",
  tennis: "Tennis",
  volleyball: "Volleyball",
  handball: "Handball",
  golf: "Golf",
  karate: "Karate",
  swimming: "Swimming"
};

// Strip a leading emoji from a string, but NEVER the ASCII digits / # / *:
// Unicode gives them Emoji=Yes because of keycap sequences like "5️⃣", which
// would otherwise eat the "5" in a stat line like "50 مباراة".
function stripLeadingEmoji(value) {
  let s = String(value == null ? "" : value);
  while (s.length) {
    const ch = s[0];
    if (/[0-9#*]/.test(ch)) break;
    const cp = s.codePointAt(0);
    if (/^\p{Emoji}$/u.test(String.fromCodePoint(cp))) {
      s = s.slice(cp > 0xffff ? 2 : 1);
      continue;
    }
    break;
  }
  return s.trim();
}

function normalizeSport(value) {
  if (!value) return "";
  const clean = stripLeadingEmoji(value);
  return SPORT_MAP[clean] || clean;
}

const LEVEL_MAP = {
  "🌱 مبتدئ": "Beginner",
  "⭐ هاوٍ": "Amateur",
  "🏅 شبه محترف": "Semi-pro",
  "🏆 محترف": "Pro",
  "💎 دولي": "International"
};

function normalizeLevel(value) {
  if (!value) return "";
  const clean = stripLeadingEmoji(value);
  for (const key of Object.keys(LEVEL_MAP)) {
    if (stripLeadingEmoji(key) === clean) return LEVEL_MAP[key];
  }
  return clean;
}

function clean(value) {
  return stripLeadingEmoji(value);
}

function randomSlug(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function buildKeywords(parts) {
  const su = require("./searchUtils");
  return su.bakeKeywords([parts].flat().filter(Boolean).join(" "));
}

function playerFromForm(data) {
  const dob = data.day && data.month && data.year
    ? `${data.year}-${String(data.month).padStart(2, "0")}-${String(data.day).padStart(2, "0")}`
    : "";
  const base = {
    name: clean(data.full_name) || "Athlete",
    slug: randomSlug(12),
    sport: normalizeSport(data.sport),
    position: clean(data.position),
    foot: clean(data.foot),
    hand: clean(data.hand),
    country: clean(data.nationality),
    dob,
    height: data.height ? Number(data.height) : null,
    weight: data.weight ? Number(data.weight) : null,
    level: normalizeLevel(data.level),
    currentClub: clean(data.current_club),
    phone: clean(data.phone),
    email: clean(data.email),
    whatsapp: clean(data.whatsapp),
    instagram: clean(data.instagram),
    stats: clean(data.stats),
    bio: clean(data.stats) || "لم يقم الرياضي بإضافة نبذة بعد",
    videos: Array.isArray(data.videos) ? data.videos : [],
    files: Array.isArray(data.files) ? data.files : [],
    available: data.available === false ? false : true,
    verified: false
  };
  // Bilingual search index baked from every searchable field (incl. bio).
  base.keywords = buildKeywords([
    base.name, base.position, base.sport, base.currentClub,
    base.country, base.level, base.stats, data.bio || ""
  ]);
  return base;
}

function clubFromForm(data) {
  const base = {
    name: clean(data.club_name),
    slug: randomSlug(12),
    type: clean(data.club_type),
    sport: normalizeSport(data.sport),
    country: clean(data.country),
    city: clean(data.city),
    founded: data.founded ? Number(data.founded) : null,
    league: clean(data.league),
    website: clean(data.website),
    contactName: clean(data.contact_name),
    contactRole: clean(data.contact_role),
    email: clean(data.official_email),
    phone: clean(data.phone),
    whatsapp: clean(data.whatsapp),
    neededPosition: clean(data.needed_position),
    logo: typeof data.logo === "string" ? clean(data.logo) : "",
    verified: false
  };
  base.keywords = buildKeywords([
    base.name, base.type, base.sport, base.country,
    base.city, base.league, base.neededPosition
  ]);
  return base;
}

module.exports = { SPORT_MAP, normalizeSport, normalizeLevel, clean, randomSlug, buildKeywords, playerFromForm, clubFromForm };