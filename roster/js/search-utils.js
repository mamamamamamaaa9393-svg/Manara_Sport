/* Shared client-side search utilities (mirror of server/src/searchUtils).
   Exposes window.SearchUtil — Arabic-aware token matching with the same
   bilingual dictionary semantics as the API. */
(function () {
  "use strict";

  function normText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\u0640]/g, "")
      .replace(/[\u064B-\u0652\u0670]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function dissolve(g) {
    var set = {};
    g.forEach(function (m) {
      String(m || "").split(/\s+/).forEach(function (w) {
        var n = normText(w);
        if (n) set[n] = true;
      });
    });
    return Object.keys(set);
  }

  /* Bilingual equivalence groups + phrases (kept in sync with the server
     dictionary). Multi-word members are dissolved into single words. */
  var GROUPS_RAW = [
    ["كرة القدم", "football", "soccer", "فوتبول", "كره القدم", "قدم"],
    ["حارس مرمى", "goalkeeper", "gk", "حارس", "حراس"],
    ["مهاجم", "striker", "forward", "st", "cf", "fw", "مهاجم صريح"],
    ["وسط", "midfielder", "cm", "dm", "am", "لاعب وسط"],
    ["مدافع", "defender", "cb", "قلب دفاع"],
    ["جناح", "winger", "wing", "lw", "rw"],
    ["ظهير", "fullback", "left back", "right back", "lb", "rb"],
    ["صانع ألعاب", "playmaker", "number10"],
    ["كرة السلة", "basketball", "سلة", "بسكتبول"],
    ["الكرة الطائرة", "volleyball", "طائرة", "فوليبول"],
    ["التنس", "tennis", "تنس"],
    ["تنس الطاولة", "table tennis", "بينج بونج"],
    ["كرة اليد", "handball", "يد"],
    ["السباحة", "swimming", "سباحة", "سباح"],
    ["الملاكمة", "boxing", "ملاكم"],
    ["الكاراتيه", "karate", "كيمتي"],
    ["الجودو", "judo", "جودو"],
    ["المصارعة", "wrestling", "مصارع"],
    ["رفع الأثقال", "weightlifting", "اثقال"],
    ["الجمباز", "gymnastics", "جمباز"],
    ["ألعاب القوى", "athletics", "جري", "عداء", "عدو"],
    ["ركوب الدراجات", "cycling", "دراجات", "هوي"],
    ["الإسكواش", "squash", "اسكواش", "إسكواش"],
    ["البادل", "padel", "بادل"],
    ["التايكوندو", "taekwondo", "تكواندو"],
    ["محترف", "professional", "pro"],
    ["دولي", "international"],
    ["شبه محترف", "semi-pro", "semipro"],
    ["هاوي", "amateur", "هواة"],
    ["مبتدئ", "beginner", "rookie"],
    ["مصر", "egypt", "egyptian", "مصري", "مصرية"],
    ["مدرب", "coach", "trainer", "تدريب"],
    ["نادي", "club", "نوادي"],
    ["أكاديمية", "academy", "اكاديمية"],
    ["منتخب", "national team", "federation", "اتحاد"],
    ["سرعة", "pace", "speed", "fast"],
    ["تهديف", "scoring", "goals", "هدف"],
    ["تمرير", "passing", "assists", "صناعة"],
    ["متاح", "available", "free agent"]
  ];

  var PHRASES_RAW = {
    "كرة قدم": "كرة القدم",
    "كره قدم": "كرة القدم",
    "كرة سلة": "كرة السلة",
    "كره سله": "كرة السلة",
    "كرة طائره": "الكرة الطائرة",
    "كره طائره": "الكرة الطائرة",
    "كرة يد": "كرة اليد",
    "كره يد": "كرة اليد",
    "حارس المرمى": "حارس مرمى",
    "حارس المرمي": "حارس مرمى",
    "لاعب وسط": "وسط",
    "صانع العاب": "صانع ألعاب",
    "تنس طاولة": "تنس الطاولة",
    "تنس الطاوله": "تنس الطاولة",
    "table tennis": "تنس الطاولة",
    "العاب قوي": "ألعاب القوى",
    "العاب القوي": "ألعاب القوى",
    "رفع اثقال": "رفع الأثقال",
    "رفع الاثقال": "رفع الأثقال",
    "شبه محترف": "شبه محترف",
    "قلب الدفاع": "مدافع",
    "منتخب وطني": "منتخب"
  };

  var GROUPS_ORIGINAL = GROUPS_RAW.map(dissolve);
  var GROUPS = GROUPS_ORIGINAL.map(function (m) { return m.slice(); });

  /* Short bridge words (<=4 chars) shared by several sports groups (e.g. bare
     كره) are removed from ALL groups to stop cross-sport leakage; they
     degrade to union-of-original-groups for plain queries below. */
  var BRIDGE_COUNT = {};
  GROUPS_ORIGINAL.forEach(function (members) {
    members.forEach(function (m) { BRIDGE_COUNT[m] = (BRIDGE_COUNT[m] || 0) + 1; });
  });
  GROUPS.forEach(function (members, i) {
    var keep = members.filter(function (m) { return BRIDGE_COUNT[m] === 1 || m.length > 4; });
    if (keep.length >= 2) GROUPS[i] = keep;
  });

  var ORIG_WORD_GROUPS = {};
  GROUPS_ORIGINAL.forEach(function (members) {
    members.forEach(function (m) {
      (ORIG_WORD_GROUPS[m] = ORIG_WORD_GROUPS[m] || []).push(members);
    });
  });

  var WORD_TO_GROUP = {};
  GROUPS.forEach(function (members) {
    members.forEach(function (m) {
      (WORD_TO_GROUP[m] = WORD_TO_GROUP[m] || []).push(members);
    });
  });

  /* Phrases resolve against PRE-FILTER groups but pin to filtered members,
     keeping only words unique to the group (+canonical). */
  function resolvePhrase(valueStr) {
    var words = normText(valueStr).split(" ").filter(Boolean);
    for (var i = 0; i < GROUPS_ORIGINAL.length; i++) {
      var orig = GROUPS_ORIGINAL[i];
      if (!words.length || !words.every(function (w) { return orig.indexOf(w) !== -1; })) continue;
      var specific = GROUPS[i].filter(function (m) { return BRIDGE_COUNT[m] === 1; });
      var canon = specific[0] || GROUPS[i][0] || words[0];
      var g = specific.slice();
      if (g.indexOf(canon) === -1) g.push(canon);
      return { t: canon, g: g, raw: words };
    }
    return null;
  }

  var stripAl = function (w) { return w.length > 3 && w.indexOf("ال") === 0 ? w.slice(2) : w; };
  var PHRASES = {};
  Object.keys(PHRASES_RAW).forEach(function (k) {
    var val = resolvePhrase(PHRASES_RAW[k]);
    if (!val) return;
    var nk = normText(k);
    var stripped = nk.split(" ").map(stripAl).join(" ");
    PHRASES[nk] = val;
    if (stripped !== nk) PHRASES[stripped] = val;
  });

  /* Normalize -> merge known phrases -> token list.
     plain word -> {t,g:null,raw:[w]} ; phrase hit -> {t,g,raw}. */
  function tokens(text) {
    var words = normText(text).split(" ").filter(Boolean);
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var ph, consumed2 = false;
      if (i + 1 < words.length) {
        ph = PHRASES[words[i] + " " + words[i + 1]];
        if (!ph) ph = PHRASES[stripAl(words[i]) + " " + stripAl(words[i + 1])];
        if (ph) consumed2 = true;
      }
      if (!ph) ph = PHRASES[words[i]];
      if (ph && ph.g) { out.push(ph); if (consumed2) i++; continue; }
      out.push({ t: words[i], g: null, raw: [words[i]] });
    }
    return out;
  }

  /* Query expansion: pinned phrase tokens use their own group only; plain
     tokens union ALL groups containing them (original groups as fallback). */
  function expand(text) {
    return tokens(text).map(function (tok) {
      var set = [tok.t];
      var add = function (m) { if (set.indexOf(m) === -1) set.push(m); };
      if (tok.g) tok.g.forEach(add);
      else {
        var groups = WORD_TO_GROUP[tok.t] || ORIG_WORD_GROUPS[tok.t] || [];
        groups.forEach(function (g) { g.forEach(add); });
      }
      return set;
    });
  }

  function wrap(s) { return " " + normText(s) + " "; }

  function hit(hay, t) {
    if (t.length <= 3) return hay.indexOf(" " + t + " ") !== -1;
    return hay.indexOf(t) !== -1;
  }

  // AND-match every expanded query group against a raw text haystack.
  function match(haystackText, expandedTokens) {
    if (!expandedTokens || !expandedTokens.length) return true;
    var hay = wrap(haystackText);
    return expandedTokens.every(function (set) {
      for (var i = 0; i < set.length; i++) if (hit(hay, set[i])) return true;
      return false;
    });
  }

  window.SearchUtil = { norm: normText, tokens: tokens, expand: expand, match: match };
})();
