# توثيق منطق إنشاء الحساب وتسجيل الدخول — منصة منارة (Auth Flow)

> **منارة — منصة اكتشاف المواهب الرياضية** — شرح كامل ومفصّل لمنطق إنشاء الحساب (تسجيل) وتسجيل الدخول:
> الواجهة الأمامية، الخادم، الجلسات والرموز، التحقق عبر البريد، دور الإدارة، وضوابط الأمان.
> الملف توثيقي فقط — **لا يعدّل أي كود**.

---

## 1. نظرة عامة

- **الواجهة الأمامية**: صفحات ثابتة (Vanilla JS) داخل `roster/` — أهمها `Sign/Sign_In.html` و `Sign/Sign_Up.html` و `Sign/pending.html`.
- **الخادم**: Node/Express يكشف مسارات `/api/auth/*` من `server/src/routes/auth.routes.js`.
- **الهوية**: بعد الموافقة تُصدَر **JWT** تُرسل في **Cookie آمن (httpOnly)** باسم `manara_token`، ولا تُخزَّن في localStorage أبداً (فقط علامة `manara_session` غير حساسة).
- **قاعدة بيانات**: MongoDB Atlas أساساً مع **نجدة JSON file** (`server/data/db.json`) عند تعذّر الاتصال.
- **مهم**: إنشاء الحساب لا يُنجِز جلسة — الحساب يُنشأ بحالة `pending` وبعد موافقة الأدمن يمكن تسجيل الدخول.

---

## 2. خريطة الملفات الأساسية

| المسار | الدور |
|---|---|
| `roster/Sign/Sign_In.html` | صفحة تسجيل الدخول + استرداد كلمة المرور |
| `roster/Sign/Sign_Up.html` | صفحة إنشاء الحساب (لاعب/نادي) + التحقق من البريد |
| `roster/Sign/pending.html` | متابعة حالة الطلب (استطلاع كل 10 ثوانٍ) |
| `roster/js/api.js` | عملاء الـ API وإدارة علامة الجلسة المخزّنة محلياً |
| `roster/js/lang.js` | نصوص ثنائية اللغة (`auth.*`) |
| `roster/js/nav-auth.js` ، `roster/js/main.js` | تبديل شريط التنقل حسب تسجيل الدخول |
| `server/src/routes/auth.routes.js` | **كل مسارات المصادقة** (التسجيل، الدخول، OTP، الاسترداد، الحذف) |
| `server/src/routes/admin.routes.js` | مراجعة طلبات التسجيل (موافقة/رفض) |
| `server/src/middleware/auth.js` | توقيع/التحقق من JWT وإدارة الـ Cookie |
| `server/src/middleware/rateLimit.js` | حدّ معدّل الطلبات لكل IP |
| `server/src/db.js` | طبقة التخزين (MongoDB / JSON) + التطهير |
| `server/src/email.js` | إرسال رموز التحقق والردود بالبريد |
| `server/src/seed.js` | إنشاء حساب الأدمن (`admin@manara.app`) |

---

## 3. نموذج البيانات

**مجموعة `users`** — الحساب الرئيسي:
```
{ id: "u_…", role: "player"|"club"|"admin",
  email, name, passwordHash (bcrypt),
  approved: boolean, createdAt,
  failedLoginAttempts, lockedUntil,
  resetToken, resetExpires, resetLockedUntil }
```

**مجموعة `registrations`** — طلب الانتساب قيد المراجعة:
```
{ id: "r_…", userId, role, email, name,
  status: "pending"|"approved"|"rejected",
  statusToken (hex عشوائي — يسمح بمتابعة الحالة دون جلسة),
  reviewedAt, retryAfter, adminNote,
  photo, documents, videos, data: safeData }
```

**مجموعة `verifications`** — سجلات OTP للتحقق من البريد أثناء التسجيل:
```
{ id: "v_…", email, code (6 أرقام), expiresAt (15 دقيقة),
  attempts, verified: boolean }
```

---

## 4. إنشاء الحساب (Sign-Up)

### 4.1 المسار خطوة بخطوة
1. يفتح المستخدم `/Sign/Sign_Up.html` ويختار الدور (**لاعب `#pForm`** أو **نادي `#cForm`**).
2. يملأ البيانات ويرفع الملفات (صور/وثائق/فيديوهات) عبر `POST /api/upload/register-upload` (بدون جلسة، مع حصص بالبايت لكل IP).
3. **التحقق من البريد إلزامي** (انظر §6).
4. الضغط على إرسال → `window.API.register(data, role)` → `POST /api/auth/register`.
5. يتحقق الخادم من كل القيود ثم ينشئ: سجل `user` (بـ `approved:false`) + الملف الشخصي + سجل `registration` بحالة `pending` + `statusToken`.
   **لا تُصدَر جلسة** — الرد: `201 {status:"pending", registrationId, statusToken, message}`.
6. الواجهة تخزّن `manara_reg` في localStorage وتوجه إلى `pending.html?role=…&id=…&token=…&email=…`.
7. `pending.html` يستعلم `POST /api/auth/status` كل **10 ثوانٍ** حتى الموافقة/الرفض.
8. يقدّم الأدمن على الحساب (الموافقة/الرفض — §7).
9. بعد الموافقة يمكن للمستخدم تسجيل الدخول بنفس البريد وكلمة المرور.

### 4.2 قائمة التحقق على الخادم (`auth.routes.js:89-231`)
- `role` يجب أن يكون `player` أو `club`.
- صيغة بريد صحيحة، و`password.length >= 6`، و`password === password_confirm`.
- المستندات الإلزامية موجودة (لاعب: شهادة ميلاد + طبي + إقرار توقيع؛ نادي: خطاب رسمي + ترخيص).
- البريد **مُتحقق منه بـ OTP** (سجل `verifications` بـ `verified === true` وغير منتهي الصلاحية — تنتهي الصلاحية بعد 15 دقيقة).
- اللاعب يملك **فيديو تمييز واحد على الأقل**.
- **الحسابات المسبقة**: موجود مفعّل → `409`؛ قيد المراجعة → `409 {status:"pending"}`؛ مرفوض ومازالت فترة إعادة المحاولة (`retryAfter` = 15 دقيقة) → `429`؛ انتهت المدة → حذف القديم وإنشاء طلب جديد.
- `bcrypt.hash(password, 10)` ثم إنشاء السجلات وتثبيت ملكية الملفات (`claimUploads`) حتى لا يحذفها المسح الدوري.

---

## 5. تسجيل الدخول (Sign-In)

### 5.1 المسار خطوة بخطوة
1. يفتح المستخدم `/Sign/Sign_In.html`؛ الصفحة تتحقق من الاتصال عبر `GET /api/health`.
2. إرسال `loginForm` → `window.API.login(email, password)` (`api.js:115`) → `POST /api/auth/login` `{email, password}`.
3. الخادم (`auth.routes.js:355-424`):
   - تطبيع البريد + بحث المستخدم.
   - **قفل الحساب**: إن كان `user.lockedUntil` مستقبلياً → `423` مع الدقائق المتبقية.
   - `bcrypt.compare`؛ عند الفشل يزيد `failedLoginAttempts` (عند **5 محاولات** → قفل **15 دقيقة** `423`) وإلا `401`.
   - عند النجاح: تصفير العدّاد وإزالة القفل.
   - **بوابة موافقة الأدمن**: إن كان `approved === false` → إذا كان الطلب مرفوضاً `403 {status:"rejected", retryAfter}` وإلا `403 {status:"pending"}`.
   - `sign(user)` → JWT لمدة **7 أيام** مع `jti` فريد لكل دخول، ثم `setAuthCookie` (Cookie httpOnly `manara_token`)؛ يُعيد `{token, user, profile}` (الـ token أيضاً في JSON للتطبيقات/الاختبارات).
4. الواجهة: تخزّن علامة `manara_session = {id, role}` فقط، وتحويل الأدمن إلى `admin.html` وغيره إلى `?redirect=` أو `index.html`؛ حالتي `pending`/`rejected` تعرضان إشعاراً مع روابط إلى `pending.html`/`Sign_Up.html`.

### 5.2 استخدام الجلسة
- كل طلب يحمل الـ Cookie تلقائياً (`credentials:"include"` في `api.js:37`).
- `GET /api/auth/me` يعيد المستخدم + الملف الشخصي + حالة الموافقة؛ يُستدعى عند تحميل الصفحات لتحديد شريط التنقل وحماية الصفحات (`main.js:647`، `nav-auth.js:49`).

### 5.3 تسجيل الخروج
- `POST /api/auth/logout` يضيف الـ JWT إلى **قائمة إلغاء في الذاكرة** لمدة صلاحيته ويمسح الـ Cookie؛ الواجهة تزيل `manara_session` (`api.js:121-125`).
- ملاحظة: الإلغاء في الذاكرة — لكل عملية خادم (single-instance) فقط، وبلا آلية تسجيل خروج من كل الأجهزة.

---

## 6. التحقق من البريد (OTP)

### 6.1 إرسال الرمز — `POST /api/auth/send-verification` (`auth.routes.js:268-310`)
- يتحقق من صحة البريد، يُنشئ `verificationId` ورمزاً من 6 أرقام (`crypto.randomInt(100000,1000000)`)، `expiresAt = +15 دقيقة`، `attempts:0`.
- يرسل البريد عبر `email.js sendVerificationCode`.
- **في وضع التطوير (dev)** يُعيد الـ `devCode` في الرد ليُملأ تلقائياً (نيابةً عن قراءة البريد).
- حد المعدل: **10 إرسالات لكل IP خلال 15 دقيقة**.

### 6.2 التحقق من الرمز — `POST /api/auth/verify-email` (`auth.routes.js:314-350`)
- بحث بالسجل `verificationId`.
- **5 أخطاء** → حذف السجل + `429`.
- رمز خاطئ → زيادة `attempts` (`400` تحذير من المحاولة الثالثة).
- منتهي الصلاحية → `400`.
- نجاح → `record.verified = true` ← `{verified:true, email}`.

---

## 7. دور الإدارة في إنشاء الحساب (`admin.routes.js`)

| الإجراء | النهاية | الأثر |
|---|---|---|
| الموافقة | `POST /api/admin/registrations/:id/approve` | `reg.status="approved"`، `user.approved=true`، `profile.verified=true`، **بدء التجربة المجانية** (لاعب يومان / نادٍ 7 أيام)، تخزين الإقرار، بريد `sendRegistrationApproved` |
| الرفض | `POST /api/admin/registrations/:id/reject` | `reg.status="rejected"`، `retryAfter = +15 دقيقة`، `adminNote`، بريد `sendRegistrationRejected` |

---

## 8. استرداد كلمة المرور

1. `POST /api/auth/forgot-password` (`auth.routes.js:454-487`): بريد غير معروف → `404`؛ يضبط `resetToken` (6 أرقام) و`resetExpires = +15 دقيقة`؛ في dev يُعيد `devCode` ليُملأ تلقائياً.
2. `POST /api/auth/reset-password` (`auth.routes.js:490-551`): يتحقق من الرمز وكلمة المرور الجديدة (≥6 + تطابق التأكيد)؛ `resetLockedUntil` يفرض `429`؛ **3 أخطاء** → قفل 15 دقيقة؛ النجاح → `bcrypt.hash(newPassword, 10)` ومسح حقول الاسترداد.

---

## 9. الجلسة والرموز (`server/src/middleware/auth.js`)

- `COOKIE_NAME = "manara_token"`؛ `SESSION_TTL_MS = 7 أيام`.
- **خصائص الـ Cookie**: `httpOnly:true`، `sameSite:"lax"`، `secure` فقط في الإنتاج أو `COOKIE_SECURE=1`، `path:"/"`.
- **سر الـ JWT**: من `JWT_SECRET` env (إلزامي في الإنتاج)؛ في dev يُولَّد سر عشوائي ويحفظ في `server/data/.dev_secret` (ملف موجود).
- `sign(user)`: الحمولة `{id, role, jti}`، `expiresIn:"7d"` — `jti` الفريد يجعل كل دخول يصدّر رمزاً مختلفاً.
- `requireAuth`/`requireAdmin`: الفحص عبر قائمة الإلغاء ثم `jwt.verify`.

**تخزين محلي** (لا يلمس الأمان): `manara_session` (علامة `{id,role}` فقط — الـ token لا يُخزَّن محلياً أبداً)، `manara_reg` (تتبّع طلب الانتساب)، `manara_lang`، `theme`.

---

## 10. ضوابط الأمان وحدود المعدل

**حدود لكل IP — نافذة ثابتة (`app.js:198-213`):**

| المسار | الحد | النافذة |
|---|---|---|
| `POST /api/auth/login` | 50 | 15 دقيقة |
| `POST /api/auth/register` | 10 | 60 دقيقة |
| `POST /api/auth/status` | 60 | 15 دقيقة |
| `POST /api/auth/send-verification` | 10 | 15 دقيقة |
| `POST /api/auth/verify-email` | 15 | 15 دقيقة |
| `POST /api/auth/forgot-password` | 10 | 15 دقيقة |
| `POST /api/auth/reset-password` | 8 | 15 دقيقة |
| `POST /api/upload` | 60 | 60 دقيقة |
| `POST /api/upload/register-upload` | 2 GB/IP + 4 GB عالمياً | وحدة بايت |

**حماية القوة الغاشمة:**
- تسجيل الدخول: **5 محاولات فاشلة → قفل 15 دقيقة**.
- OTP البريد: **5 أخطاء تُبطل السجل**.
- OTP الاسترداد: **3 أخطاء → قفل 15 دقيقة**.

**سياسات:**
- كلمة المرور: **6 أحرف كحد أدنى** (بلا تعقيد إجباري)، تخزين **bcrypt (salt=10)**.
- الرموز: OTP التسجيل والاسترداد = **15 دقيقة**؛ جلسة JWT = **7 أيام**؛ مهلة إعادة محاولة الرفض = **15 دقيقة**.
- **لا يوجد reCAPTCHA/CAPTCHA** في أي مكان؛ لا يوجد token CSRF (الاعتماد على SameSite=Lax فقط).

---

## 11. رفع الملفات أثناء التسجيل

- `POST /api/upload/register-upload` (بدون جلسة) محمي بـ `registerQuota` (`uploadQuota.js:30-51`).
- القائمة البيضاء فقط للأنواع (صور/PDF/فيديو)؛ المستندات ≤10 MB والفيديوهات ≤100 MB.
- أسماء ملفات hex عشوائية (روابط لا يمكن تخمينها).
- **التحقق من الفيديو** (`videoValidate.js:71-105`): مدة 1–10 دقائق، دقة ≥360p، ≤8 قَطعات مشهد/دقيقة (يرفض المقاطع المعدّلة).
- مسح دوري يحذف الملفات غير الملَكية **>24 ساعة** — لذلك قيمة `claimUploads` مهمة عند إتمام التسجيل.

---

## 12. طبقة التخزين (`server/src/db.js`)

- **الأساس**: MongoDB Atlas (برنامج `mongodb`، `MONGODB_URI` في `server/.env`).
- **النجدة**: ملف JSON `server/data/db.json` بكتابة ذرّية (ملف مؤقت + إعادة تسمية)؛ الملفات التالفة تُحجَز عند التحميل.
- **المجموعات**: `users, players, clubs, messages, applications, uploads, registrations, ai_chats, transactions, webhooks, reviews, profile_views, verifications, inquiries`.
- **التطهير**: `publicUser` يعيد `{id, role, email, name}` فقط؛ ملفات اللاعب والأندية تُجرد من كلمات المرور والوثائق الخاصة والوسائل.

---

## 13. سلوكيات وتفاصيل مهمة (Edge Cases)

- **انتهاء صلاحية تحقق البريد**: يجب إتمام التسجيل خلال 15 دقيقة من التحقق، وإلا يلزم إعادة التحقق.
- **الحساب المرفوض**: لا يُحذف فوراً؛ يُسمح بإعادة التسجيل بعد `retryAfter` (15 دقيقة) ومعها يُستبدل القديم.
- **رموز OTP في وضع التطوير**: `DEV_CODES=1` + `NODE_ENV=development` في `server/.env` — مطلوبة للاختبار التلقائي، **يجب إيقافها في الإنتاج**.
- **التسجيل لا يسلّم جلسة**: حتى الموافقة، المتابعة تتم عبر `statusToken` فقط (لكل طلب) أو تتبّع `manara_reg` المحلي.
- **أقراص الفيديو**: الفيديو إلزامي للاعبين ولا يصلح أي ملف تجاوز القيود.
- **حساب الأدمن**: `ensureAdmin()` في `seed.js` ينشئ `admin@manara.app` بـ bcrypt من `ADMIN_PASSWORD` (في dev: `admin123`).

---

## 14. صلاحيات قاعدة المعرفة (المعرفة / FAQ + بارمترات) — قسم 8

- **القراءة (مسارات `/knowledge/public/*`): عامة ومفتوحة** بلا مصادقة — لا حاجة لتوكن.
- **الكتابة والإدارة (`POST/PUT/DELETE /knowledge/faq`، `/knowledge/params`،
  `/knowledge/reconcile`، `/knowledge/export`، `/admin-faq` بقية المسارات):
  للأدمن فقط.**
  - لا توكن / توكن منتهي ⟶ `401`.
  - توكن لاعب/نادٍ (مصادق عليه لكنه ليس أدمن) ⟶ `403`.
  - صلاحية الأدمن تُفحص من حمولة الـ JWT (`role === "admin"`) لكل طلب كتابة —
    لا يوجد أي مسار كتابة مفتوح.
- **إخفاء المفاتيح الداخلية**: حقل `secret` ومشتقاته (internal/private/hidden/granted…)
  لا يُسلَّم أبداً عبر أي مسار للعموم، ولا عبر تصدير `params`/`faq` العام.
- **DEV_CODES / keys**: في وضع التطوير توجد أنماط أسئلة مفتوحة بلا فحص NDA؛ في
  الإنتاج تُجبر صلاحيات الأدمن بالكامل ولا تُفعَّل رموز التطوير.

---

## 15. ملخص المخطط التتابعي

```
[Sign_Up.html] ── OTP بالبريد (send-verification / verify-email)
      │  رفع الملفات (register-upload بدون جلسة)
      ▼
POST /api/auth/register ──> user(pending) + profile + registration(statusToken)
      ▼
[pending.html] ── استطلاع POST /api/auth/status كل 10 ثوانٍ
      ▼
[admin.html] ── موافقة ──> approved + verified + trial ──> بريد
      │         └─ رفض ──> rejected + retryAfter(15د) + adminNote ──> بريد
      ▼
[Sign_In.html] ── POST /api/auth/login ──> bcrypt + قفل 5 محاولات/15د
      │        ──> بوابة approved === false ──> 403 pending|rejected
      └─────────> JWT(7d, jti) في Cookie manara_token (httpOnly)
      ▼
        /api/auth/me ──> شريط التنقل وحماية الصفحات
        /api/auth/logout ──> إلغاء الرمز (في الذاكرة) + مسح الـ Cookie
```