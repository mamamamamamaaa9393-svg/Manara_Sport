/* ==========================================================================
   Manara — language switcher (AR / EN).
   Injects a toggle button next to the theme toggle on every page.
   Translates elements carrying a `data-i18n` key. Falls back to Arabic.
   ========================================================================== */
(function () {
  "use strict";

  var KEY = "manara_lang";

  var DICT = {
    // Nav / shared
    "nav.discover": { ar: "الاكتشاف", en: "Discover" },
    "nav.players": { ar: "اللاعبون", en: "Players" },
    "nav.messages": { ar: "الرسائل", en: "Messages" },
    "nav.clubs": { ar: "الأندية", en: "Clubs" },
    "nav.profile": { ar: "ملفي الشخصي", en: "My Profile" },
    "nav.shortlist": { ar: "القائمة المختصرة", en: "Shortlist" },
    "nav.jobs": { ar: "ابحث عن لاعب", en: "Find Player" },
    "nav.categories": { ar: "الأقسام", en: "Categories" },
    "nav.companies": { ar: "الأندية", en: "Companies" },
    "nav.home": { ar: "الرئيسية", en: "Home" },
    "nav.players": { ar: "اللاعبون", en: "Players" },
    "nav.about": { ar: "عن المنصة", en: "About" },
    "nav.contact": { ar: "تواصل معنا", en: "Contact" },
    "nav.terms": { ar: "الشروط", en: "Terms" },
    "nav.privacy": { ar: "الخصوصية", en: "Privacy" },
    "nav.admin": { ar: "الإدارة", en: "Admin" },
    "nav.subscribe": { ar: "الاشتراك", en: "Subscribe" },
    "nav.login": { ar: "تسجيل الدخول", en: "Login" },
    "nav.signup": { ar: "أنشئ حساباً", en: "Sign Up" },
    "nav.logout": { ar: "تسجيل الخروج", en: "Logout" },
    "nav.faq": { ar: "الأسئلة الشائعة", en: "FAQ" },

    // Footer
    "footer.for_players": { ar: "للاعبين", en: "For players" },
    "footer.for_clubs": { ar: "للأندية", en: "For clubs" },
    "footer.company": { ar: "الشركة", en: "Company" },
    "footer.legal": { ar: "قانوني", en: "Legal" },
    "footer.about": { ar: "عن المنصة", en: "About" },
    "footer.contact": { ar: "تواصل معنا", en: "Contact" },
    "footer.how": { ar: "كيف يعمل", en: "How it works" },
    "footer.partners": { ar: "الأندية الشريكة", en: "Partner clubs" },
    "footer.browse_players": { ar: "تصفح اللاعبين", en: "Browse players" },
    "footer.sports": { ar: "الرياضات", en: "Sports" },
    "footer.join_player": { ar: "انضم كلاعب", en: "Join as a player" },
    "footer.join_club": { ar: "انضم كنادي", en: "Join as a club" },
    "footer.find_players": { ar: "ابحث عن لاعبين", en: "Find players" },
    "footer.terms": { ar: "شروط الاستخدام", en: "Terms of Use" },
    "footer.privacy": { ar: "سياسة الخصوصية", en: "Privacy Policy" },
    "footer.rights": { ar: "جميع الحقوق محفوظة", en: "All rights reserved" },
    "footer.tagline": { ar: "منارة تربط الرياضيين الشباب بالأندية والأكاديميات في كل الرياضات.", en: "Manara connects young athletes with clubs and academies across every sport." },

    // Auth
    "auth.welcome": { ar: "أهلاً بعودتك", en: "Welcome back" },
    "auth.signin_title": { ar: "سجّل الدخول", en: "Sign in" },
    "auth.email": { ar: "البريد الإلكتروني", en: "Email" },
    "auth.password": { ar: "كلمة المرور", en: "Password" },
    "auth.login_btn": { ar: "تسجيل الدخول", en: "Sign in" },
    "auth.forgot": { ar: "نسيت كلمة المرور؟", en: "Forgot password?" },
    "auth.no_account": { ar: "ليس لديك حساب؟", en: "Don't have an account?" },
    "auth.create_account": { ar: "أنشئ حساباً جديداً", en: "Create an account" },
    "auth.have_account": { ar: "لديك حساب بالفعل؟", en: "Already have an account?" },
    "auth.signup": { ar: "سجّل الدخول", en: "Sign in" },
    "auth.player": { ar: "رياضي", en: "Player" },
    "auth.club": { ar: "نادي", en: "Club" },
    "auth.player_desc": { ar: "سجّل كرياضي وابدأ رحلتك في الاحتراف", en: "Register as an athlete and start your pro journey" },
    "auth.club_desc": { ar: "سجّل كمسؤول نادي واكتشف المواهب", en: "Register as a club and discover talent" },
    "auth.reset_title": { ar: "إعادة تعيين كلمة المرور", en: "Reset password" },
    "auth.new_password": { ar: "كلمة المرور الجديدة", en: "New password" },
    "auth.confirm_password": { ar: "تأكيد كلمة المرور", en: "Confirm password" },
    "auth.verify_email": { ar: "التحقق من البريد", en: "Verify email" },
    "signup.badge": { ar: "أنشئ حسابك", en: "CREATE YOUR ACCOUNT" },
    "signup.title": { ar: "أنشئ <span class=\"accent\">حسابك</span>", en: "Create your <span class=\"accent\">Account</span>" },
    "signup.choose_role": { ar: "هل أنت رياضي أم نادي؟ اختر نوع الحساب ✨", en: "Are you an athlete or a club? Choose your account type ✨" },
    "signup.have_account": { ar: "لديك حساب بالفعل؟", en: "Already have an account?" },
    "signup.login_link": { ar: "سجّل الدخول ←", en: "Sign in →" },
    "pending.badge": { ar: "تم استلام طلبك", en: "APPLICATION SUBMITTED" },
    "pending.title_pre": { ar: "طلبك", en: "Your application is" },
    "pending.title_accent": { ar: "قيد المراجعة", en: "under review" },
    "pending.sub": { ar: "نراجع ملفك بدقة قبل تفعيل الحساب — يستغرق عادةً أقل من 24 ساعة ✨", en: "We review your profile carefully before activation — usually under 24 hours ✨" },

    // Landing page (index)
    "index.eyebrow": { ar: "منارة — منصة المواهب", en: "Manara — talent platform" },
    "index.hero_title": { ar: "ابحث عن رياضي", en: "Find your athlete" },
    "index.hero_lead": { ar: "منارة تربط الرياضيين بالأندية والأكاديميات الموثوقة في كل الرياضات — بملفات شخصية موثقة، وعملية اكتشاف تحترم وقتك.", en: "Manara connects athletes with vetted clubs and academies across every sport — with verified profiles and a scouting process that respects your time." },
    "index.search_btn": { ar: "ابحث عن لاعب", en: "Search Player" },
    "index.keyword_ph": { ar: "المسمى الوظيفي أو كلمة مفتاحية", en: "Job title or keyword" },
    "search.all": { ar: "الكل", en: "All" },
    "search.players": { ar: "لاعبون", en: "Players" },
    "search.clubs": { ar: "أندية", en: "Clubs" },
    "index.location_ph": { ar: "المدينة أو عن بُعد", en: "City or remote" },
    "index.all_sports": { ar: "جميع الرياضات", en: "All sports" },
    "index.popular": { ar: "الأكثر بحثاً:", en: "Popular:" },
    "index.view_profile": { ar: "👤 عرض ملفي الشخصي", en: "👤 View my profile" },
    "index.stat_players": { ar: "لاعب مسجل", en: "Registered Players" },
    "index.stat_pro": { ar: "نادٍ محترف", en: "Professional Clubs" },
    "index.stat_academy": { ar: "أكاديمية", en: "Academies" },
    "index.stat_amateur": { ar: "نادٍ هاوٍ", en: "Amateur Clubs" },
    "index.stat_center": { ar: "مركز تدريب", en: "Training Centers" },
    "index.stat_team": { ar: "منتخب وطني", en: "National Teams" },
    "index.cat_eyebrow": { ar: "تصفح حسب الرياضة", en: "Browse by sport" },
    "index.cat_title": { ar: "اكتشف المواهب في كل رياضة", en: "Discover talent across every sport" },
    "index.cat_sub": { ar: "تصفح الرياضيين الموثقين، وراجع ملفاتهم، وراسل من تريد.", en: "Browse verified athletes, review their profiles and message the ones you want." },
    "cat.soon": { ar: "قريباً", en: "Coming soon" },
    "index.browse_clubs": { ar: "تصفح الأندية الموثقة ←", en: "Browse verified clubs →" },

    // 404 page
    "err.title": { ar: "الصفحة غير موجودة", en: "Page not found" },
    "err.msg": { ar: "الرابط الذي حاولت الوصول إليه غير موجود أو تم نقله.", en: "The page you are looking for doesn't exist or has been moved." },
    "err.home": { ar: "العودة للرئيسية", en: "Back to home" },

    // Subscribe page
    "sub.auth_title": { ar: "سجّل الدخول أولاً", en: "Sign in first" },
    "sub.auth_sub": { ar: "للاشتراك وإرسال رسالتك المجانية، تحتاج حساباً موثّقاً في منارة.", en: "To subscribe and send your free message, you need a verified Manara account." },
    "sub.auth_btn": { ar: "تسجيل الدخول ←", en: "Sign in →" },
    "sub.gamer_eyebrow": { ar: "⚡ ردّك مجاني لأول مرة", en: "⚡ Your first reply is free" },
    "sub.gamer_title": { ar: "أرسل رسالتك الأولى مجاناً —<br>الرد الذكي بانتظارك", en: "Send your first message free —<br>the smart reply is waiting" },
    "sub.gamer_sub": { ar: "أول رسالة مجانية بالكامل. رد المساعد يُجهَّز لك فوراً، لكنه يُعرض مقفلاً حتى تفتح اشتراكك بـ 39 ج.م شهرياً.", en: "Your first message is fully free. The AI reply is prepared instantly but stays locked (preview only) until you unlock it with a 39 EGP/month subscription." },
    "sub.gamer_ph": { ar: "اكتب رسالتك… مثال: كيف أختار النادي المناسب لمستواي؟", en: "Type your message… e.g. How do I choose the right club for my level?" },
    "sub.send": { ar: "إرسال", en: "Send" },
    "sub.proof_replied": { ar: "رد وصل اليوم", en: "replies today" },
    "sub.proof_activate": { ar: "يفعّلون خلال دقيقة", en: "activate within a minute" },
    "sub.proof_rating": { ar: "تقييم المساعد", en: "assistant rating" },
    "sub.club_eyebrow": { ar: "🏟️ بوابة تواصل النادي", en: "🏟️ Club communication gateway" },
    "sub.club_title": { ar: "أول رسالة من لاعب<br>تصل إليك بعد التفعيل مباشرة", en: "The first player message<br>arrives right after activation" },
    "sub.club_sub": { ar: "فعّل اشتراك النادي (299 ج.م شهرياً) لاستقبال طلبات اللاعبين والتواصل معهم وتقييم ملفاتهم بالفيديو والوثائق.", en: "Activate the club subscription (299 EGP/month) to receive player requests, contact them and review their video + document profiles." },
    "sub.demo": { ar: "📞 اطّلع أولاً — اطلب عرضاً توضيحياً", en: "📞 See it first — book a demo" },
    "sub.pay_method": { ar: "طريقة الدفع (تحويل لمحفظة منارة)", en: "Payment method (transfer to Manara wallet)" },
    "sub.wallet_label": { ar: "محفظة منارة الرسمية", en: "Manara official wallet" },
    "sub.wallet_hint": { ar: "حوّل المبلغ إلى هذا الرقم ثم أرفق صورة الإيصال", en: "Transfer the amount to this number, then attach the receipt screenshot" },
    "sub.how_link": { ar: "📘 كيف أدفع؟ — خطوات مفصّلة ←", en: "📘 How to pay? — detailed steps →" },
    "sub.amount_label": { ar: "المبلغ المدفوع (ج.م)", en: "Amount paid (EGP)" },
    "sub.amount_ph": { ar: "مثال: 10", en: "e.g. 10" },
    "sub.ref_label": { ar: "رقم المحفظة/الرقم المرجعي للتحقق", en: "Wallet / reference number for verification" },
    "sub.ref_ph": { ar: "مثال: 01012345678", en: "e.g. 01012345678" },
    "sub.receipt_label": { ar: "صورة إيصال الدفع", en: "Payment receipt screenshot" },
    "sub.receipt_btn": { ar: "📎 اضغط لرفع صورة الإيصال", en: "📎 Tap to upload the receipt screenshot" },
    "sub.pay_btn": { ar: "🔒 تأكيد الدفع وإرساله للمراجعة", en: "🔒 Confirm payment and submit for review" },
    "sub.pending_title": { ar: "طلب الدفع بانتظار المراجعة", en: "Payment request awaiting review" },
    "sub.online_btn": { ar: "💳 ادفع أونلاين الآن (كارت / محفظة)", en: "💳 Pay online now (card / wallet)" },
    "sub.online_note": { ar: "بوابة كاشير الآمنة — فيزا/ماستركارد + فودافون كاش والمحافظ. تفعيل فوري بدون رفع إيصال.", en: "Secure Kashier gateway — Visa/Mastercard + Vodafone Cash and wallets. Instant activation, no receipt upload." },
    "sub.online_or": { ar: "أو ادفع يدوياً", en: "Or pay manually" },
    "sub.active_title": { ar: "اشتراكك نشط", en: "Your subscription is active" },

    // Plans page
    "plans.eyebrow": { ar: "اشترك في منارة الرياضية", en: "Subscribe to Manara Sports" },
    "plans.title": { ar: "خطط بسيطة تناسب الجميع", en: "Simple plans for everyone" },
    "plans.sub": { ar: "اختر خطتك وابدأ رحلتك — اللاعبون يصلون إلى الأندية، والأندية تكتشف المواهب. مع فترة تجريبية مجانية بدون أي التزام.", en: "Choose your plan and start your journey — players reach clubs, clubs discover talent. With a free trial and no commitment." },
    "plans.player_name": { ar: "خطة اللاعب", en: "Player Plan" },
    "plans.player_desc": { ar: "لكل رياضي شاب يرغب في الوصول إلى الأندية والأكاديميات", en: "For every young athlete who wants to reach clubs and academies" },
    "plans.per_month": { ar: "ج.م / شهرياً", en: "EGP / month" },
    "plans.player_trial": { ar: "يومان تجربة مجانية", en: "2 days free trial" },
    "plans.pf1": { ar: "ملف شخصي كامل بالعربية (نبذة + فيديو + إحصائيات)", en: "Full Arabic profile (bio + video + stats)" },
    "plans.pf2": { ar: "تصفح ملفات الأندية والأكاديميات", en: "Browse club and academy profiles" },
    "plans.pf3": { ar: "استقبال طلبات الأندية (انتقال / تجربة / اكتشاف)", en: "Receive club requests (transfer / trial / discovery)" },
    "plans.pf4": { ar: "محادثة مباشرة مع الأندية", en: "Direct chat with clubs" },
    "plans.pf5": { ar: "رفع الفيديوهات والصور مع ضغط تلقائي", en: "Upload videos and photos with auto-compression" },
    "plans.pf6": { ar: "تحديثات مجانية طوال مدة الاشتراك", en: "Free updates during your subscription" },
    "plans.player_cta": { ar: "اشترك كرياضي", en: "Subscribe as an athlete" },
    "plans.popular": { ar: "⭐ الأكثر طلباً", en: "⭐ Most popular" },
    "plans.club_name": { ar: "خطة النادي", en: "Club Plan" },
    "plans.club_desc": { ar: "للأندية والأكاديميات الباحثة عن المواهب واللاعبين الجاهزين", en: "For clubs and academies looking for talent and ready players" },
    "plans.club_trial": { ar: "7 أيام تجربة مجانية", en: "7 days free trial" },
    "plans.cf1": { ar: "ملف نادٍ / أكاديمية كامل", en: "Full club / academy profile" },
    "plans.cf2": { ar: "لوحة بحث بفلاتر (رياضة، مركز، بلد، مستوى)", en: "Search board with filters (sport, position, country, level)" },
    "plans.cf3": { ar: "قائمة مختصرة + ملاحظات سكاوت خاصة", en: "Shortlist + private scout notes" },
    "plans.cf4": { ar: "بدء المحادثات مع اللاعبين مباشرة", en: "Start conversations with players directly" },
    "plans.cf5": { ar: "إرسال طلبات توظيف (انتقال / تجربة / اكتشاف)", en: "Send recruitment requests (transfer / trial / discovery)" },
    "plans.cf6": { ar: "تقييم اللاعبين بالنجوم (1-5) + عدّاد من شاهد ملفك", en: "Star ratings (1-5) + profile view counter" },
    "plans.cf7": { ar: "مساعد ذكي + دعم فني مميز", en: "Smart assistant + premium support" },
    "plans.club_cta": { ar: "اشترك كنادٍ", en: "Subscribe as a club" },
    "plans.pay_title": { ar: "طرق الدفع الآمنة", en: "Secure payment methods" },
    "plans.vf_cash": { ar: "فودافون كاش", en: "Vodafone Cash" },
    "plans.vf_hint": { ar: "حول المبلغ وارفع صورة الإيصال", en: "Transfer the amount and upload the receipt" },
    "plans.fawry": { ar: "فوري", en: "Fawry" },
    "plans.fawry_hint": { ar: "ادفع من أي منفذ أو تطبيق فوري", en: "Pay from any Fawry outlet or app" },
    "plans.pay_note": { ar: "إيصالك يُفحص تلقائياً (مبلغ، تاريخ، رقم مرجعي) للتأكد من صحته، ثم يُفعَّل اشتراكك فوراً — مع مراجعة يدوية عند أي شك.", en: "Your receipt is checked automatically (amount, date, reference number), then your subscription activates instantly — with manual review when in doubt." },
    "plans.faq_title": { ar: "الأسئلة الشائعة", en: "Frequently Asked Questions" },
    "plans.q1": { ar: "كيف أدفع قيمة الاشتراك؟", en: "How do I pay for my subscription?" },
    "plans.a1": { ar: "عبر المحافظ المصرية: حوّل المبلغ إلى حساب منارة (فودافون كاش أو فوري) ثم ارفع صورة الإيصال من صفحة الاشتراك. يُفحص الإيصال تلقائياً ويُفعَّل الاشتراك بعد تأكيده.", en: "Via Egyptian wallets: transfer the amount to Manara's account (Vodafone Cash or Fawry), then upload the receipt from the subscribe page. The receipt is checked automatically and your subscription activates after confirmation." },
    "plans.q2": { ar: "ما هي مدة الفترة التجريبية المجانية؟", en: "How long is the free trial period?" },
    "plans.a2": { ar: "للاعب: يومان كاملان مجاناً، وللنادي أو الأكاديمية: 7 أيام كاملة مجاناً. يمكنك تجربة كل المزايا قبل الاشتراك الفعلي.", en: "Players get 2 full free days, clubs and academies get 7 full free days. Try every feature before subscribing." },
    "plans.q3": { ar: "هل يمكنني إلغاء التجديد التلقائي؟", en: "Can I cancel auto-renewal?" },
    "plans.a3": { ar: "نعم، من صفحة إدارة الاشتراك يمكنك إلغاء التجديد أو استئنافه في أي وقت، وتصلك تذكيرات قبل انتهاء الفترة المدفوعة.", en: "Yes — from the subscription management page you can cancel or resume renewal anytime, and you get reminders before the paid period ends." },
    "plans.q4": { ar: "هل تشمل الخطة جميع الرياضات؟", en: "Does the plan cover all sports?" },
    "plans.a4": { ar: "نعم، تغطي منصة منارة جميع الرياضات — كرة القدم، السلة، اليد، السباحة، التنس وغيرها — بدون أي رسوم إضافية.", en: "Yes — Manara covers all sports: football, basketball, handball, swimming, tennis and more — with no extra fees." },
    "plans.outro": { ar: "لديك سؤال آخر؟ تواصل مع فريق الدعم عبر المنصة وسنرد عليك في أقرب وقت.", en: "Another question? Contact the support team through the platform and we'll reply as soon as possible." },

    // Profile / club-profile sections
    "profile.bio": { ar: "نبذة عن الرياضي", en: "About the athlete" },
    "profile.videos": { ar: "فيديوهات ومقاطع المباريات", en: "Videos & match highlights" },
    "profile.documents": { ar: "المستندات الرسمية", en: "Official documents" },
    "profile.declaration": { ar: "صورة الإقرار", en: "Declaration image" },
    "profile.quick_info": { ar: "معلومات سريعة", en: "Quick info" },
    "profile.contact": { ar: "معلومات التواصل", en: "Contact info" },
    "profile.reviews": { ar: "تقييم الأندية", en: "Club ratings" },
    "clubprofile.about": { ar: "عن النادي", en: "About the club" },
    "clubprofile.needs": { ar: "اللاعبون المطلوبون", en: "Players wanted" },
    "clubprofile.squad": { ar: "لاعبو النادي", en: "Club players" },
    "clubprofile.shortlist": { ar: "القائمة المختصرة", en: "Shortlist" },
    "clubprofile.compare": { ar: "⚖️ مقارنة", en: "⚖️ Compare" },
    "profile.scout_note": { ar: "🕵️ ملاحظة سكاوت خاصة (لا يراها اللاعب)", en: "🕵️ Private scout note (hidden from the player)" },
    "profile.viewers": { ar: "من شاهد بروفايلك", en: "Who viewed your profile" },
    "clubprofile.docs": { ar: "المستندات الرسمية", en: "Official documents" },
    "clubprofile.quick": { ar: "معلومات سريعة", en: "Quick info" },
    "clubprofile.contact": { ar: "بيانات التواصل", en: "Contact details" }
  };

  function currentLang() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === "ar" || saved === "en") return saved;
    } catch (e) {}
    // Per-page authored language (e.g. data-default-lang="ar" on Arabic pages).
    var def = document.documentElement.getAttribute("data-default-lang");
    return def === "ar" || def === "en" ? def : "en";
  }

  function setLang(lang) {
    try { localStorage.setItem(KEY, lang); } catch (e) {}
    document.documentElement.lang = lang === "en" ? "en" : "ar";
    document.documentElement.dir = "ltr";
    translate();
    updateButton();
  }

  function translate() {
    var lang = currentLang();
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var dict = DICT[key];
      if (!dict) return;
      var text = dict[lang] || dict.ar;
      if (/<[a-zA-Z]/.test(text)) {
        el.innerHTML = text;
      } else {
        el.textContent = text;
      }
    });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-ph");
      var dict = DICT[key];
      if (!dict) return;
      el.setAttribute("placeholder", dict[lang] || dict.ar);
    });
  }

  function updateButton() {
    var btn = document.getElementById("langToggle");
    if (btn) {
      var lang = currentLang();
      btn.textContent = lang === "en" ? "عربي" : "EN";
      btn.title = lang === "en" ? "Switch to Arabic" : "التبديل إلى الإنجليزية";
      btn.setAttribute("aria-label", btn.title);
    }
  }

  function injectButton() {
    var themeBtn = document.getElementById("themeToggle");
    if (!themeBtn) return;
    if (document.getElementById("langToggle")) return;

    var btn = document.createElement("button");
    btn.id = "langToggle";
    btn.type = "button";
    btn.className = "theme-toggle lang-toggle";
    btn.setAttribute("aria-label", "Switch language");
    btn.title = "Switch language";
    btn.style.cssText = "margin-inline-start:8px;";
    themeBtn.parentNode.insertBefore(btn, themeBtn.nextSibling);

    btn.addEventListener("click", function () {
      setLang(currentLang() === "en" ? "ar" : "en");
    });
    updateButton();
  }

  function init() {
    var lang = currentLang();
    document.documentElement.lang = lang === "en" ? "en" : "ar";
    document.documentElement.dir = "ltr";
    injectButton();
    translate();
    updateButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();