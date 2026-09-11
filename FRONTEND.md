# توثيق الواجهة الأمامية لمنصة منارة (Manara Frontend)

> **منارة — منصة اكتشاف المواهب الرياضية** — توثيق كامل ومفصّل للواجهة الأمامية:
> البنية، الخطوط، الألوان، الأيقونات، الصور، صفحات HTML، ملفات JavaScript، PWA، وتحسين محركات البحث.

---

## 1. نظرة عامة

- **الواجهة كلها داخل مجلد `roster/`** — صفحات HTML ثابتة (static) + CSS + JavaScript خالص (Vanilla JS، بدون jQuery ولا أي مكتبة Frontend).
- **Backend**: خادم Node/Express يستقبل الطلبات عبر `/api` من `js/api.js`.
- **الخطوط**: Google Fonts (3 عائلات في صفحة الهبوط، وعائلتان في صفحات التسجيل).
- **نظام التصميم**: ملف واحد هو مصدر الحقيقة `css/tokens.css` للألوان والخطوط في الوضعين الفاتح والداكن، مربوط بمتغيرات CSS (Custom Properties).
- **ثنائي اللغة**: عربي (RTL افتراضياً) / إنجليزي (LTR) عبر `js/lang.js`.
- **ثيم ليلي/نهاري**: عبر `js/theme.js` + خاصية `data-theme`.
- **PWA**: `manifest.json` + `sw.js` (حبس `manara-v8`).

---

## 2. بنية الدليل الكاملة

```
roster/                      <- جذر الواجهة الأمامية
├── index.html               <- صفحة الهبوط الرئيسية (26.4 KB)
├── jobs.html                <- تصفح اللاعبين / لوحة البحث (9.6 KB)
├── clubs.html               <- الأندية (5.9 KB)
├── club-profile.html        <- ملف نادي (5.9 KB)
├── profile.html             <- ملف اللاعب (11.1 KB)
├── shortlist.html           <- القائمة المختصرة (5.7 KB)
├── messages.html            <- الرسائل (7.9 KB)
├── subscribe.html           <- الاشتراك (28.4 KB)
├── plans.html               <- الباقات (15.3 KB)
├── admin.html               <- لوحة الإدارة (17.2 KB)
├── admin-declarations.html  <- إقرارات الإدارة (15.9 KB)
├── ai-assistant.html        <- مساعد Manara الذكي (4.9 KB)
├── inquiry-track.html       <- تتبع الاستفسار (7.7 KB)
├── about.html               <- عن المنصة (20.8 KB)
├── contact.html             <- تواصل معنا (16.5 KB)
├── terms.html               <- شروط الاستخدام (17.5 KB)
├── privacy.html             <- سياسة الخصوصية (18.1 KB)
├── 404.html                 <- صفحة غير موجودة (1.8 KB)
│
├── Sign/                    <- صفحتا التسجيل والدخول + حالة الطلب
│   ├── Sign_Up.html         (44.6 KB)
│   ├── Sign_In.html         (16.1 KB)
│   └── pending.html         (13.2 KB)
│
├── css/
│   ├── tokens.css           <- توكنز التصميم الموحّدة (286 سطراً)
│   ├── style.css            <- طبقة تصميم "Roster" المخصصة (482 سطراً)
│   └── vendor/
│       ├── bootstrap.min.css <- Bootstrap 5 (227 KB)
│       ├── Style_Sig.css     <- تنسيقات صفحات Sign (571 سطراً)
│       └── porfile.css       <- تنسيقات ملف اللاعب (778 سطراً)
│
├── js/                      <- 18 ملفاً (تفاصيلها في القسم 8)
│
├── img/
│   ├── logo.png             <- شعار منارة 256×256 (92.5 KB)
│   ├── favicon.ico + favicon-16/32/48/64
│   ├── hero-candidate.jpg   (62.5 KB)
│   ├── images.jpg           (49.2 KB)
│   ├── employer-team.jpg    (91.1 KB)
│   ├── person-1.jpg / person-2.jpg / person-3.jpg
│
├── icons/                   <- أيقونات PWA
│   ├── icon-180.png         (50.2 KB)
│   ├── icon-192.png         (56.8 KB)
│   └── icon-512.png         (319.1 KB)
│
├── files/
│   └── Manara-Safe-Contract-Agreement.pdf  (243 KB)
│
├── manifest.json
├── sw.js
├── robots.txt
└── sitemap.xml
```

---

## 3. الخطوط (Fonts) — التفصيل الكامل

### 3.1 روابط Google Fonts في `<head>`

**صفحات الهبوط/المحتوى (مثل `index.html`):**

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=Figtree:wght@400;500;600;700&family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">
```

| الخط | الأوزان المحمّلة | الاستخدام |
|---|---|---|
| **Plus Jakarta Sans** | 600, 700, 800 | العناوين (`--font-display`) |
| **Figtree** | 400, 500, 600, 700 | النصوص (`--font-body`) |
| **Cairo** | 400, 600, 700, 900 | الدعم العربي (الأول للعربية) |

**صفحات التسجيل (مثل `Sign/Sign_In.html`):**

```html
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
```

| الخط | الأوزان المحمّلة | الاستخدام |
|---|---|---|
| **Cairo** | 400, 600, 700, 900 | النصوص والعناوين العربية |
| **Inter** | 400, 500, 600, 700, 800, 900 | النصوص اللاتينية |

### 3.2 متغيرات الخطوط في `css/tokens.css`

```css
--font-display: "Plus Jakarta Sans", "Cairo", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-body:    "Figtree", "Cairo", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-app:     "Cairo", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
```

- `--font-display` → العناوين `h1..h6` (وزن 800، تباعد أحرف `-.02em`، ارتفاع سطر 1.12).
- `--font-body` → النصوص العامة و`<body>` (حجم 1.0625rem، ارتفاع سطر 1.65، `-webkit-font-smoothing: antialiased`).
- `--font-app` → صفحات التطبيق الداخلية (Sign/Profile).

---

## 4. نظام الألوان — التوكنز الموحّدة (`css/tokens.css`)

> مصدر الحقيقة الوحيد للألوان. يوجد **عائلتان للتصميم** تم توحيدهما في هذا الملف:
> **Family A** (متغيرات صفحة الهبوط من قالب Roster: `--ink`, `--primary`...) و
> **Family B** (متغيرات صفحات التطبيق: `--gray-*`, `--dark`...).

### 4.1 الوضع الفاتح (Light)

| المجموعة | المتغير | القيمة |
|---|---|---|
| **الأسطح** | `--surface` | `#ffffff` |
| | `--nav-bg` | `rgba(255,255,255,0.88)` |
| | `--band` (أقسام داكنة دائمة: الفوتر/الـ flow) | `#0b1120` |
| **نصوص Family A** | `--ink` | `#111a2e` |
| | `--ink-2` | `#384156` |
| | `--muted` | `#6b7488` |
| | `--faint` | `#98a0b3` |
| **خطوط/حدود** | `--line` | `#e6e9f2` |
| | `--line-2` | `#eef1f7` |
| **خلفيات** | `--bg` | `#ffffff` |
| | `--bg-soft` | `#f4f6fb` |
| | `--bg-soft-2` | `#eef2fb` |
| **اللون الأساسي (أزرق)** | `--primary` | `#2a4bd8` |
| | `--primary-ink` | `#1e37a8` |
| | `--primary-2` | `#4364e6` |
| | `--primary-soft` | `#eaeefc` |
| | `--primary-glow` | `rgba(42,75,216,0.28)` |
| **مميز / كهرماني** | `--accent` | `#ffb020` |
| | `--accent-ink` | `#b57400` |
| | `--accent-soft` | `#fff3d6` |
| **أخضر** | `--green` / `--green-ink` / `--green-soft` | `#12a870` / `#0c7a51` / `#def3ea` |
| **بنفسجي** | `--violet` | `#7c5cf0` |
| **وردي** | `--rose` | `#f0567f` |
| **فيروزي** | `--teal` | `#10a4b0` |
| **Family B** | `--dark` | `#0f172a` |
| | `--gray-900` / `--gray-700` / `--gray-500` | `#1e293b` / `#475569` / `#64748b` |
| | `--gray-300` / `--gray-200` / `--gray-100` / `--gray-50` | `#cbd5e1` / `#e2e8f0` / `#f1f5f9` / `#f8fafc` |
| | `--white` | `#ffffff` |
| | `--primary-light` | `#eef2ff` |
| | `--green-bg` | `#d1fae5` |
| | `--orange` / `--orange-bg` | `#f59e0b` / `#fef3c7` |

### 4.2 الوضع الداكن (Dark — `html[data-theme="dark"]`)

| المتغير | القيمة |
|---|---|
| `--surface` | `#151c31` |
| `--nav-bg` | `rgba(13,19,38,0.82)` |
| `--band` | `#0b1120` |
| `--ink` / `--ink-2` | `#eef2ff` / `#c7d0e4` |
| `--muted` / `--faint` | `#94a0bf` / `#6b789a` |
| `--line` / `--line-2` | `#26304c` / `#1f2840` |
| `--bg` / `--bg-soft` / `--bg-soft-2` | `#0e1426` / `#161e34` / `#1c2440` |
| `--primary` / `--primary-ink` / `--primary-2` | `#4a6cf7` / `#6b87ff` / `#3d5ce0` |
| `--primary-soft` / `--primary-glow` | `#1b2444` / `rgba(74,108,247,0.35)` |
| `--accent` / `--accent-ink` / `--accent-soft` | `#ffc24d` / `#ffd988` / `#3a2d10` |
| `--green` / `--green-ink` / `--green-soft` | `#34d399` / `#7fe8bd` / `#0c2a21` |
| `--violet` / `--rose` / `--teal` | `#8f76ff` / `#f06a92` / `#2fc3cf` |
| `--dark` / `--gray-900` | `#eef2ff` / `#eef2ff` |
| `--gray-700` / `--gray-500` | `#c3cce1` / `#94a0bf` |
| `--gray-300` / `--gray-200` | `#5b6785` / `#2a3352` |
| `--gray-100` / `--gray-50` / `--white` | `#1c2440` / `#161e34` / `#0e1426` |
| `--primary-light` / `--green-bg` | `#1c2440` / `#0c2a21` |
| `--orange` / `--orange-bg` | `#fbbf24` / `#2b2110` |

### 4.3 خلفية `body` في الوضع الداكن لصفحات التطبيق

ثلاث تدرّجات شعاعية + لون أساس:

```css
html[data-theme="dark"] body {
  background:
    radial-gradient(ellipse 900px 600px at 85% 5%,   rgba(74,108,247,0.13), transparent 55%),
    radial-gradient(ellipse 800px 500px at 10% 90%,  rgba(255,194,77,0.05),  transparent 55%),
    radial-gradient(ellipse 1000px 700px at 50% 50%, rgba(143,118,255,0.06), transparent 60%),
    #0e1426;
}
```

### 4.4 الأنصاف والظلال والحاوية

```css
--radius: 14px;  --radius-sm: 10px;  --radius-lg: 22px;  --radius-pill: 999px;

--shadow-xs: 0 1px 2px rgba(17,26,46,0.06);
--shadow-sm: 0 4px 14px rgba(17,26,46,0.06);
--shadow-md: 0 14px 34px rgba(17,26,46,0.08);
--shadow-lg: 0 30px 70px rgba(17,26,46,0.14);
--shadow-primary: 0 16px 34px rgba(42,75,216,0.28);

--container: 1200px;   /* أقصى عرض للحاوية */
--nav-h: 76px;         /* ارتفاع شريط التنقل */
```

(أما في الداكن فتُستبدل الظلال بظلال سوداء `rgba(0,0,0,...)` ومفتاح أزرق `rgba(74,108,247,0.32)`.)

---

## 5. `css/style.css` — طبقة تصميم قالب Roster

> قالب **"Roster — Free Bootstrap 5 job board & careers template by uiCookies"** مع طبقة تخصيص كاملة مبنية على توكنز Manara.

### 5.1 الأساسيات (Base)

- `* { box-sizing: border-box }`، `html { scroll-behavior: smooth }` (مع `prefers-reduced-motion`).
- `body`: خط `--font-body`، لون `--ink-2`، خلفية `--bg`، حجم 1.0625rem، ارتفاع سطر 1.65.
- العناوين: خط `--font-display`، وزن 800، لون `--ink`، ارتفاع سطر 1.12.
- `:focus-visible`: مخطط خارجي `--primary-glow` (3px) + offset 2px.
- كلاس `.tnum` → `font-variant-numeric: tabular-nums`.

### 5.2 الأزرار

| الكلاس | الوصف |
|---|---|
| `.btn-primary` | أزرق `--primary`، ظل `--shadow-primary`، hover يرفع الزر `-1px` |
| `.btn-accent` | كهرماني `--accent`، نص بلون `#3a2600`، ظل خاص بالكهرماني |
| `.btn-outline-ink` | حدود من `--line` على `--surface`، hover بخلفية `--band` |
| `.btn-ghost` | شفاف بدون حدود |
| `.btn-pill` | زوايا `--radius-pill` (حبة كبسولة) |
| `.btn-lg` | حشوة أكبر للاستخدام البارز |

### 5.3 شريط التنقل (`.site-nav`)

- **ثابت أعلى (sticky)** وبدرجة z-index 1030، خلفية `--nav-bg` مع **backdrop-filter blur(14px) saturate(180%)**.
- عند التمرير يُضاف `.is-stuck` (حدود سفلية + ظل).
- `.nav-inner` بارتفاع `var(--nav-h)` = 76px.
- **الشعار `.brand-mark`** (أهم عنصر باللوغو):
  ```css
  .brand-mark {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(135deg, var(--primary), var(--primary-2));
    display: grid; place-items: center;
    box-shadow: var(--shadow-primary);
  }
  .brand-mark img { width: 100%; height: 100%; object-fit: cover; }
  ```
- النص: `Man<b>ara</b>` — الحرف b بلون `--primary`.
- **الهاتف (≤991px)**: زر `.nav-toggle` (3 شرط Hamburger) يفتح القائمة المنسدلة، مع الحفاظ على إمكانية الوصول بدون JS (أصناف تبدأ بـ `.js`).

### 5.4 المكوّنات الرئيسية الأخرى

- `.hero` — قسم الترحيب بخلفية تدرّجات شعاعية (أزرق + كهرماني على `--bg-soft`)، شبكة `1.05fr .95fr`.
- `.searchbar` — شريط بحث بطاقات (keyword / category / زر) بتصميم مخمّد وظل.
- `.stats` — شريط إحصائيات 4 أعمدة.
- `.cat-grid` / `.cat-card` — شبكة الرياضات بألوان مميزة لكل رياضة (`.c-eng`، `.c-des`، `.c-mkt`، `.c-sal`، `.c-fin`، `.c-hea`، `.c-sup`، `.c-rem`).
- `.job` — بطاقة اللاعب؛ `grid-template-columns: auto 1fr auto`، hover يرفع البطاقة.
- `.logo-chip` — **أيقونة 54px داخل بطاقة اللاعب**:
  ```css
  .logo-chip { width: 54px; height: 54px; border-radius: 13px; display: grid; place-items: center; ... }
  .logo-chip img { width: 100%; height: 100%; object-fit: cover; border-radius: 13px; background: #fff; }
  ```
  مع متغيرات لونية: `.lc-blue .lc-violet .lc-green .lc-amber .lc-rose .lc-teal .lc-ink`.
- `.flow` — قسم "كيف يعمل" على خلفية `--band` داكنة مع تبويبات.
- `.faq` — أسئلة شائعة `<details>` مع علامة "+" متحركة.
- `.board-grid` — تخطيط `300px 1fr` للفلاتر + النتائج في `jobs.html`، الفلاتر **sticky**.
- `.switch` — مبدّل عن بُعد (remote) بتصميم دائري.
- `.reveal` — ظهور تدريجي عند التمرير عبر IntersectionObserver مع تأخيرات `.reveal-d1..d5` (ويُعطّل مع `prefers-reduced-motion`).

---

## 6. ملفات CSS الإضافية (vendor)

### 6.1 `css/vendor/bootstrap.min.css` (~227 KB)
نسخة مصغّرة من Bootstrap 5 — تُحمَّل في كل صفحة محتوى قبل `style.css`، وتُستخدم كلاساتها (`.btn`, `.container`, الشبكات...) جنباً إلى جنب مع التخصيص.

### 6.2 `css/vendor/Style_Sig.css` (571 سطراً — ~14 KB)
تنسيقات **صفحات Sign** (تسجيل الدخول، إنشاء حساب، حالة الطلب): بطاقات النماذج، اختيار الدور (لاعب/نادي)، أزرار، إشعارات "قيد المراجعة"، وتوافق مع توكنز tokens.css.

### 6.3 `css/vendor/porfile.css` (778 سطراً — ~20 KB)
تنسيقات **ملف اللاعب** (profile): تخطيط البطاقات، الشارات، مقاطع الفيديو، التقييمات، المستندات، ولوحة سرعة + خلفيات متدرجة، متوافق مع الوضعين.

---

## 7. الصور (`img/`) — التفصيل

| الملف | الحجم | الاستخدام |
|---|---|---|
| `logo.png` | 94,745 B (~92.5 KB) | شعار منارة — **256×256 PNG بشفافية (Format32bppArgb)** |
| `favicon.ico` | 9,178 B | أيقونة المتصفح (ملتيدر) |
| `favicon-16.png` | 927 B | مقاس 16×16 |
| `favicon-32.png` | 2,778 B | مقاس 32×32 |
| `favicon-48.png` | 5,419 B | مقاس 48×48 |
| `favicon-64.png` | 8,871 B | مقاس 64×64 |
| `hero-candidate.jpg` | 64,001 B | صورة بطل الصفحة الرئيسية (نسبة 5:6) |
| `images.jpg` | 50,376 B | صورة محتوى عامة |
| `employer-team.jpg` | 93,317 B | صورة فريق/شركاء |
| `person-1.jpg` | 6,682 B | أفاتار شخص 1 |
| `person-2.jpg` | 4,750 B | أفاتار شخص 2 |
| `person-3.jpg` | 6,851 B | أفاتار شخص 3 |

### 7.1 ملاحظات الـ Logo

- أعيد تصغيره من **1254×1254 (1,162.7 KB) إلى 256×256 (92.5 KB)** بنسبة توفير ~92%.
- **الشفافية محفوظة**: الزاوية العليا اليسرى `(0,0)` → Alpha=0، مركز الأيقونة `(128,128)` → Alpha=253.
- مراجع الشعار (27 مرجعاً): الشريط العلوي والفوتر في كل صفحة عبر `js/partials.js`، و`og:image` وJSON-LD في `index.html`، وصفحة النادي، والرموز `img/logo.png`.
- مقاسات العرض الفعلية: 34px (شريط التنقل)، 26px (الفوتر)، 43px (صفحات Sign)، 54px (chip اللاعب).
- **تحقق "لا فرق بصري"**: فرق متوسط ≤6/255 (من 255) في كل المقاسات على الوضع الحقيقي عبر متصفح headless — والفرق كله على حواف antialiasing داخل رسم الأيقونة فقط.
- النسخة الأصلية محفوظة للاحتياط خارج المشروع (`logo_original_1254.png`).

---

## 8. صفحات HTML — الدليل

### 8.1 صفحات المحتوى (22 صفحة)

| الصفحة | الوظيفة | التنسيق |
|---|---|---|
| `index.html` | الهبوط/الرئيسية: hero + بحث + إحصائيات + رياضات + كيف يعمل + FAQ | `style.css` |
| `jobs.html` | تصفح اللاعبين مع فلاتر (حسب الموضع/المستوى/العمر/الطول/البلد/الراتب) + بحث + تبويبات | `style.css` |
| `clubs.html` | شبكة الأندية الموثقة (قابلة للتصفية) | `style.css` |
| `club-profile.html` | ملف نادي (خاص بالموقّعين فقط) | `style.css` |
| `profile.html` | ملف اللاعب الكامل (إحصائيات، فيديو، تقييمات، مستندات) | `porfile.css` |
| `shortlist.html` | القائمة المختصرة (خاص بالموقّعين) | `style.css` |
| `messages.html` | محادثات داخل التطبيق | `style.css` |
| `subscribe.html` | صفحة الاشتراك + الدفع | `style.css` |
| `plans.html` | الباقات والأسعار | `style.css` |
| `admin.html` | لوحة الإدارة (مراجعة الطلبات، المستخدمين، السجلات) | `style.css` |
| `admin-faq.html` | لوحة إدارة قاعدة المعرفة (FAQ + بارامترات + تقرير المصالحة + تصدير) — للرول أدمن فقط؛ تُحمَّل من `/api/knowledge/faq` و`/api/knowledge/params` | `style.css` + `admin-faq.js` |
| `admin-declarations.html` | قسم الإقرارات المحمي بكلمات سر | `style.css` |
| `ai-assistant.html` | مساعد Manara الذكي (نافذة دردشة) | `style.css` |
| `inquiry-track.html` | تتبع رد الإدارة على الاستفسار | `style.css` |
| `contact.html` | نموذج تواصل + خريطة | `style.css` |
| `terms.html` | شروط الاستخدام | `style.css` |
| `privacy.html` | سياسة الخصوصية | `style.css` |
| `404.html` | صفحة غير موجودة | `style.css` |
| `manifest.json` | إعدادات PWA (قسم 10.1) | — |
| `robots.txt` | إرشادات محركات البحث (قسم 11) | — |
| `sitemap.xml` | خريطة الموقع (قسم 11) | — |
| `sw.js` | Service Worker (قسم 10.2) | — |

### 8.2 صفحات Sign (مجلد `Sign/`)

| الصفحة | الوظيفة | التنسيق |
|---|---|---|
| `Sign_Up.html` | إنشاء حساب — اختيار الدور (رياضي/نادي) + رفع المستندات (بطاقة ميلاد، تقرير طبي، إقرار) + فيديو بارز | `Style_Sig.css` |
| `Sign_In.html` | تسجيل الدخول + إعادة تعيين كلمة المرور + التحقق من البريد | `Style_Sig.css` |
| `pending.html` | صفحة انتظار مراجعة الحساب | `Style_Sig.css` |

---

## 9. `<head>` الموحّد — ما تحمله كل صفحة

ترتيب التحميل النموذجي (مأخوذ من `index.html`):

```html
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#0b1220">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="منارة">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<link rel="icon" type="image/x-icon" href="img/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="img/favicon-32.png">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>منارة — منصة اكتشاف المواهب الرياضية</title>
<meta name="description" content="...">
<meta property="og:title|description|type|url|image" ...>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/vendor/bootstrap.min.css">
<link rel="stylesheet" href="css/style.css">
<script src="js/theme.js"></script>      <!-- قبل أول رسم (لا وميض) -->
<script src="js/lang.js"></script>
<link rel="canonical" href="https://manara.app/">
<script type="application/ld+json" id="manara-org-jsonld">...</script>
```

> **ملاحظة تنسيق**: `<script>` يُضاف ثم `document.documentElement.classList.add('js')` في سطر مستقل في أعلى `<head>` قبل CSS.

---

## 10. ملفات JavaScript (18 ملفاً) — الأدوار

| الملف | الأسطر/الحجم | الدور |
|---|---|---|
| `partials.js` | 40 / 33.1 KB | يضخّ الشريط العلوي والفوتر في كل صفحة عبر `data-partial` (16 شريطا + 6 فوترات بخانات محفوظة لكل صفحة) — يُنفَّذ **قبل** كل شيء |
| `theme.js` | 42 / 1.6 KB | محوّل الوضع الفاتح/الداكن، يحفظ في localStorage، يدعم `?theme=dark\|light`، ويقرأ `prefers-color-scheme` |
| `lang.js` | 302 / 28.9 KB | محوّل اللغة AR/EN، يضيف زر `langToggle`، يترجم عناصر `data-i18n` من قاموس داخلي (~150 مفتاحاً) |
| `api.js` | 286 / 14.1 KB | عميل API: `request()` عبر fetch مع `credentials: include` (JWT في كوكي httpOnly)، + `xhrUpload()` لرفع الملفات مع تقدم حقيقي (وهو 10 دقائق) |
| `main.js` | 634 / 30.5 KB | منطق الصفحة الرئيسية و jobs: البحث، الفلاتر، التنقل، الـ tabs، ظهور تدريجي، إعادة التحميل، فهارس |
| `nav.js` | 62 / 2.1 KB | ربط زر الشريط العلوي (توسيع/طي) للصفحات غير المضمّنة في main |
| `nav-auth.js` | 70 / 2.9 KB | تبديل الشريط حسب حالة الدخول (إخفاء "Sign in/Up" وإظهار اسم المستخدم) |
| `sub-banner.js` | 102 / 5.6 KB | شريط الاشتراك المشترك (تذكير النسخة التجريبية للمواقع بوضع صحيح) |
| `search-utils.js` | 193 / 8.4 KB | `window.SearchUtil` — مطابقة توكن عربية/إنجليزية (وضع فهرسة) |
| `profile.js` | 674 / 36.9 KB | صفحة ملف اللاعب: جلب بيانات، تعبئة كل الأقسام، تقييمات، فيديو، مستندات (fallback لعينة ثابتة) |
| `club-profile.js` | 361 / 23.2 KB | ملف النادي (يتطلب تسجيل دخول)، مع `esc()` لتطهير HTML |
| `clubs.js` | 144 / 7.4 KB | شبكة الأندية في `clubs.html` + تصفية + منع المراسلة من قطع أجنبية |
| `messages.js` | 301 / 12.6 KB | الدردشة داخل التطبيق: محادثات، رسائل، شارة غير مقروءة |
| `shortlist.js` | 178 / 8.6 KB | القائمة المختصرة (يتطلب تسجيل دخول) |
| `subscribe.js` | 453 / 22.8 KB | صفحة الاشتراك: auth-check، حالة الاشتراك، قيود اللاعبين/الأندية، الدفع (صورة/فوري/كاشير) |
| `ai-assistant.js` | 128 / 5.7 KB | محادثة مساعد Manara الذكي (POST /ai/chat) |
| `admin.js` | 630 / 31.7 KB | لوحة الإدارة: مراجعة طلبات التسجيل، المستندات، المعاملات، المستخدمين، السجلات |
| `inquiry-notify.js` | 56 / 3.0 KB | إشعار رد الإدارة على الاستفسار (يتابع التوكن في localStorage ويظهر toast) |

### 10.1 `api.js` — كشف النقاط (API surface)

| المجموعة | النقاط |
|---|---|
| Auth | login, logout, getMe, register, forgotPassword, resetPassword, sendVerification, verifyEmail, deleteAccount |
| Players | getPlayers, getPlayer, createPlayer, updatePlayer, ratePlayer (`/review`), shortlistPlayer, scoutNote, getStats |
| Clubs | getClubs, getClub, createClub, updateClub, clubDelete |
| Messages | sendMessage, getThreads, getConversation, getUnreadCount |
| Applications | createApplication, getApplications |
| Upload | `upload` / `uploadRegister` (XHR مع progress، مهلة 10 دقائق) |
| Admin | adminRegistrations, adminApprove/Reject, adminTransactions, adminApprove/RejectTransaction, adminDeclarationsStatus, adminDeclarationFile, adminDeleteUser, adminLogs |
| Subscription | subscriptionStatus, subscriptionCancel/Resume, subscriptionChat, submitPayment, kashierCheckout, myChats |
| Inquiries | submitInquiry, getInquiryByToken, adminInquiries, adminInquiry, adminReplyInquiry |
| AI | aiChat |

---

## 11. PWA — الوضع دون اتصال

### 11.1 `manifest.json`

```json
{
  "name": "منارة — منصة اكتشاف المواهب الرياضية",
  "short_name": "منارة",
  "lang": "ar",
  "dir": "rtl",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#0b1220",
  "theme_color": "#0b1220",
  "categories": ["sports", "social"],
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

### 11.2 `sw.js` — Service Worker (الإصدار `manara-v8`)

**الأصول المسبقة (CORE):** `/`, `/index.html`, `/subscribe.html`, `/terms.html`, `/privacy.html`, `/404.html`, `/css/tokens.css`, `/css/style.css`, `/css/vendor/bootstrap.min.css`, `/js/theme.js`, `/js/lang.js`, `/js/api.js`, `/icons/icon-192.png`, `/icons/icon-512.png`.

**استراتيجية التخزين:**

| النوع | الاستراتيجية |
|---|---|
| التنقل (صفحات) | **Network-first**: يحدّث من الشبكة ويخزّن، وفي حالة الفشل يعيد القشرة المخزنة (Fallback `/index.html`) |
| الأصول الثابتة | **Stale-while-revalidate**: يعيد المخزّن فوراً ثم يحدّث في الخلفية |
| `/api/` و`/uploads/` | **لا تُخزَّن أبداً** (خصوصية) |
| مصادر خارجية (خطوط) | لا تُمَس |

> ملاحظة: `install` يستخدم `skipWaiting()` و`activate` يحذف المفاتيح القديمة و`clients.claim()`.

---

## 12. SEO والبنية الدلالية

### 12.1 `robots.txt`

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin.html
Disallow: /admin-declarations.html
Disallow: /Sign/
Disallow: /messages.html
Sitemap: https://manara.app/sitemap.xml
```

### 12.2 `sitemap.xml`

- `/` (weekly, 1.0)
- `/jobs.html` (daily, 0.9)
- `/Sign/Sign_Up.html` (monthly, 0.8)
- `/Sign/Sign_In.html` (monthly, 0.7)

### 12.3 Open Graph و Schema.org

- `og:type = website`، `og:url = https://manara.app/`، `og:image = img/logo.png`.
- JSON-LD `Organization`: name منارة / alternateName Manara + logo `https://manara.app/img/logo.png`.
- `canonical` = `https://manara.app/`.

---

## 13. الارتباط المتقاطع ونمط الكود

- **ثنائي اللغة حسب الصفحة**: صفحات الهبوط `lang="ar" dir="rtl"`، صفحات Sign تحمل `data-default-lang="ar"`.
- **تمرير الخلفية**: الشراكات/فوتر يدمجون الإصدارين AR/EN معاً.
- **الأمان**: الهوية تُقرأ من كوكي httpOnly؛ localStorage يحوي **علامة غير حسّاسة** فقط `{ id, role }` وليس التوكن نفسه. كل الإدراج يُطهَّر عبر `esc()`.
- **أسماء متغيّرة**: متغيرات CSS تُعرف بـ`--kebab-case`، والدوال JS بنمط `camelCase`، والأكوام escape بترميز `HTML entities`.

---

## 14. ملاحظات الأداء (مقترحات غير منفّذة بعد)

- Bootstrap بأكمله (227 KB) محمّل في كل صفحة محتوى — يمكن تقليل الحجم بعمل build مخصص.
- 3 عائلات خطوط على صفحة الهبوط (Plus Jakarta Sans + Figtree + Cairo) تبطئ أول رسم — يمكن الاكتفاء بـ Cairo لعربية.
- لا يوجد gzip/compression في `server/src/app.js` حاليًا.
- لا توجد عناوين Cache-Control على الأصول الثابتة (يتعامل معها `sw.js` في وضع المتصفحات الداعمة فقط).
- ~197 KB من JavaScript تُحمَّل في كل صفحة — يجدر تفكيك الوحدات (code-splitting) للصفحات غير التفاعلية.
```

## ملخص سريع للقرارات الجوهرية

1. **الخطوط**: Plus Jakarta Sans (عناوين) + Figtree (نصوص) + Cairo (عربي) + Inter (App).
2. **الألوان**: توكنز موحدة، الأزرق `#2a4bd8` أساسي، كهرماني `#ffb020` مميز، وداكن متكامل.
3. **الشعار**: 256×256 PNG بشفافية — معتمدة بصرياً بمقاييس أقل من 6/255 من 255.
4. **PWA**: v8 مع network-first للصفحات وstale-while-revalidate للملفات الثابتة.
5. **الاشتقاق**: كل الواجهة تعتمد على `tokens.css` كمصدر الحقيقة — أي تغيير لوني/خطّي يتم فيه فقط.