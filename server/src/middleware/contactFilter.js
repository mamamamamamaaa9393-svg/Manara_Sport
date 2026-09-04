/* ==========================================================================
   Contact-solicitation filter for in-app messaging.
   Blocks any message that tries to move the conversation off the platform
   (asking for a phone number, email, whatsapp, instagram, outside contact…).
   Applied to BOTH parties — clubs and players.
   ========================================================================== */

// Normalize Arabic text so "أعطيني" == "اعطيني" == "اعطني" when matching,
// and strip diacritics / tatweel / punctuation.
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "") // tashkeel (diacritics)
    .replace(/[\u0640]/g, "")        // tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation & symbols
    .replace(/\s+/g, " ")
    .trim();
}

// Phrases that reveal/request contact data. Sorted longest-first so the
// most specific phrase wins when reporting back to the user.
const BANNED = [
  // phone
  "اعطيني رقمك", "اعطني رقمك", "ارسل رقمك", "ابعث رقمك", "بعت رقمك", "اكتب رقمك",
  "رقم هاتفك", "رقم الهاتف", "رقم هاتف", "رقم موبايلك", "رقم الموبايل", "رقم موبايل",
  "رقم الواتس", "رقم واتس", "هاتفك", "موبايلك", "رقمك",
  // messaging apps
  "الواتساب", "واتساب", "واتس اب", "واتس", "whatsapp", "telegram", "viber", "سكايب", "سناب", "snap",
  // email
  "الايميل", "الايميلك", "ايميلك", "ايميل", "email", "e mail", "بريدك", "رقم البريد", "mailto",
  // social media
  "انستجرام", "انستغرام", "instagram", "insta", "تابعني", "facebook", "فيس بوك", "فيس",
  // moving the conversation off-platform
  "علي الخاص", "على الخاص", "تواصل خارج", "خارج المنص", "phone", "telephone", "mobile"
].sort((a, b) => b.length - a.length);

// Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and Persian variants to ASCII so
// number patterns below cannot be bypassed by writing ٠١٠١٢٣٤٥٦٧٨.
function normalizeDigits(text) {
  return String(text || "").replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) =>
    String(d.charCodeAt(0) & 0xf)
  );
}

// Raw contact DATA patterns — a bare phone/email/handle leaks contact info
// without ever using a banned REQUEST phrase ("كلمني 01012345678" passes the
// phrase list). Checked on digit-normalized, lowercased text.
const CONTACT_PATTERNS = [
  { re: /\b01[0125]\d{8}\b/, label: "رقم هاتف" },                 // Egyptian mobile
  { re: /\b\d{7,15}\b/, label: "رقم هاتف" },                      // generic long digit runs (intl numbers)
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, label: "بريد إلكتروني" },   // emails
  { re: /\b(t\.me|wa\.me|bit\.ly|tinyurl|tiny\.cc|is\.gd)\S*/i, label: "رابط تواصل" }, // shortener / messenger links
  { re: /\b[\w.-]*(whatsapp|telegram|viber|snapchat)[\w.-]*\.\w{2,}\S*/i, label: "رابط تواصل" } // messenger domains
];

// Returns the matched phrase or null (message is fine to send).
function findContactAttempt(text) {
  const n = normalize(text);
  if (!n) return null;
  for (const phrase of BANNED) {
    if (n.includes(phrase)) return phrase;
  }
  const flat = normalizeDigits(String(text || "")).toLowerCase();
  for (const p of CONTACT_PATTERNS) {
    const m = flat.match(p.re);
    if (m) return p.label + " (" + m[0].slice(0, 20) + ")";
  }
  return null;
}

module.exports = { normalize, findContactAttempt, BANNED };