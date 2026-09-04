/* ==========================================================================
   Manara AI Assistant — Manara-only guard.
   Determines whether a question is about the Manara platform BEFORE it is ever
   sent to the language model. This is a local, deterministic check so it cannot
   be bypassed by prompt injection inside the user message (the model is only
   called when this gate already passed).

   Priority: injection attempt or clearly off-topic -> reject. Otherwise if any
   Manara-related term is present -> allow. Ambiguous (no signal either way) ->
   reject, to be safe (better refuse than answer an off-platform question).
   ========================================================================== */

// Substring terms that strongly indicate a Manara-related question.
const ALLOW = [
  "manara", "منارة", "مناره",
  "لاعب", "لاعبين", "لاعبة", "player", "players",
  "نادي", "نوادي", "club", "clubs",
  "اشتراك", "subscription", "subscrib", "الاشتراكات",
  "دفع", "pay", "payment", "الدفع", "فاتورة", "فودافون", "فوري", "محفظة", "كاشير", "kashier",
  "scout", "كشافة", "سكاوتي", "استكشاف",
  "فيديو", "video", "فيديوهات", "هایلایت", "highlight",
  "ملف", "profile", "الملف الشخصي", "الملف الرياضي", "البروفايل", "بياناتي", "ملفي", "حسابي",
  "بحث", "search", "تصفية", "فلتر", "فلاتر",
  "استفسار", "inquir", "الاستفسارات", "تواصل", "contact",
  "تسجيل", "register", "sign up", "إنشاء حساب", "حساب",
  "رسائل", "message", "messages", "محادثة",
  "إشعار", "notification", "تنبيه", "التنبيهات",
  "خطة", "plan", "الخطط", "باقة", "الباقات",
  "سعر", "price", "الأسعار", "تكلفة",
  "تقييم", "rating", "تقييمات", "مراجعة", "review",
  "قواعد", "rules", "القواعد", "سياس", "policy", "الشروط", "terms",
  "منصة", "platform", "المنصة",
  "رياضي", "رياضية", "athlete", "رياضيين",
  "أكاديمية", "أكاديميات", "academy", "الأكاديمية",
  "انتقال", "transfer", "انتقالات", "تعاقد", "عقد",
  "مهارات", "skills", "المهارات", "تطوير",  "توثيق", "verify", "تحقق", "موثّق", "موثق", "التحقق", "verified",
  "وثيقة", "document", "الوثائق", "شهادة", "طبية", "ميلاد",
  "إحصائيات", "stats", "statistics",
  "shortlist", "قائمة المفضلة", "المفضلة", "المفضلين",
  "تسجيل الدخول", "login", "تسجيل دخول", "دخول",
  "كلمة المرور", "password", "الرقم السري", "إعادة تعيين", "reset", "استعادة",
  "بريد", "email", "البريد الإلكتروني", "ايميل",
  "رفع", "upload", "تحميل", "صورة", "photo",
  "إدارة", "admin", "الإدارة",
  "رياضة", "sport", "الرياضات", "كرة القدم", "football",
  "تحديث", "تعديل", "مجاني", "مجانية", "الخدمة", "استخدام", "كيفية استخدام",
  // Smart Matching / recommendations (legitimate in-scope Manara capability)
  "رشح", "رشّح", "رشد", "اقترح", "انصح", "أنصح", "نصح", "توصية", "مقترح", "مقترحة", "توصي",
  "مهاجم", "مدافع", "حارس", "جناح", "وسط", "فوروارد", "ارتكاز",
  "striker", "defender", "goalkeeper", "winger", "midfielder", "forward", "guard", "center", "position",
  "مركز", "المركز", "مراكز", "المراكز"
];

// Clearly off-topic topics that must never reach the model.
const DENY = [
  "طقس", "weather", "حالة الجو",
  "أخبار", "news", "جريدة",
  "سياسة", "politics", "حكومة", "رئيس", "وزير", "انتخابات",
  "برمجة", "programming", "كود", "code", "python", "جافا", "javascript", "java", "لغة برمجة", "تكويد",
  "لعبة", "ألعاب", "game", "games", "gaming",
  "فيلم", "أفلام", "movie", "movies", "مسلسل", "دراما",
  "طبخ", "وصفة", "cooking", "وصفات",
  "رياضيات", "math", "تاريخ", "جغرافيا", "فيزياء", "كيمياء",
  "دين", "إسلام", "مسيح", "صلاة", "قرآن",
  "البورصة", "stock", "crypto", "بيتكوين", "عملة رقمية"
];

// Attempts to override the assistant's instructions / extract secrets.
const INJECTION = [
  "ignore previous", "ignore all", "تجاهل التعليمات", "تجاهل كل", "أنت الآن", "you are now",
  "pretend you", "تظاهر أنك", "اطبع تعليمات", "اكشف تعليمات", "system prompt",
  "تعليمات النظام", "print your instructions", "reveal your", "اكشف سرك", "secret key", "api key"
];

function hasAny(text, list) {
  for (const term of list) {
    if (text.indexOf(term) !== -1) return true;
  }
  return false;
}

// Returns { inScope: boolean, reason: string }.
function classifyScope(rawText) {
  const text = " " + String(rawText || "").toLowerCase() + " ";
  const injection = hasAny(text, INJECTION);
  const deny = hasAny(text, DENY);
  const allow = hasAny(text, ALLOW);

  if (injection && !allow) return { inScope: false, reason: "injection" };
  // Off-topic dominates for safety: reject even if a Manara word slips in
  // alongside a clearly off-platform topic.
  if (deny) return { inScope: false, reason: "offtopic" };
  if (allow) return { inScope: true, reason: "allow" };
  return { inScope: false, reason: "ambiguous" };
}

module.exports = { classifyScope, ALLOW, DENY, INJECTION };
