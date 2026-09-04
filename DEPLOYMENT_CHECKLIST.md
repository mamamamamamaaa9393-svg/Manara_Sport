# 🚀 دليل رفع منصة منارة على استضافة سيرفر (VPS)

**الهدف:** تحويل المشروع من بيئة التطوير المحلية (Windows) إلى استضافة إنتاجية (Linux VPS) دون كسر أي شيء.
**تنبيه هام:** هذا الملف **وثيقة فقط** — لا ينفّذ أي تغيير في الكود. نفّذه يدوياً عند النشر.

---

## 1️⃣ قبل رفع أي ملف: تأمين التطبيق محلياً (خطوة واحدة في المشروع)

- افتح `server/.env` وعدّل هذين السطرين:
  ```
  NODE_ENV=production        # بدلاً من development
  DEV_CODES=1                # ⚠️ احذف/علّق هذا السطر تماماً
  ```
  > بدون هذا، أكواد التحقق (OTP) ستظهر في استجابات الـ API لأي شخص على الموقع!

- أضف هذين السطرين الجديدين (قيمهما تتوقف على الدومين):
  ```
  CORS_ORIGIN=https://domanek.com,https://www.domanek.com
  TRUST_PROXY=1
  ```
  > `CORS_ORIGIN`: دومينك الحقيقي بدل `*`.
  > `TRUST_PROXY`: يخبر Express أن nginx أمامه حتى يعمل التحديد/الحجب بمعرفة IP المستخدم الحقيقي.

---

## 2️⃣ الملفات التي يجب رفعها إلى السيرفر كاملة (مع الحفاظ على البنية)

```
manara-server/                        ← مجلد server كاملاً
  server.js
  package.json
  node_modules/                       ← يفضل تشغيل npm install هناك بدل نقله
  .env                                ← ملف الأسرار (انظر القسم 4)
  uploads/                            ← انقله إذا كان فيه ملفات مستخدمين حقيقية
  data/                               ← انقله! فيه db.json + ملفات الخزنة المشفرة + .dev_secret
  manifest.json (اختياري)
sererstack الواجهة/roster/           ← مجلد roster كاملاً (HTML/JS/CSS/صور)

ملفات لا ترفع:
  الاختبارات المؤقتة *.tmp.js
  server/test/* (اختياري)
```

---

## 3️⃣ إعداد قاعدة البيانات (MongoDB Atlas)

**أهم قرار في النشر — قلص نطاقه:**

| الخيار | الوصف | التوصية |
|--------|--------|---------|
| **أ) محلي + سحابة معاً** | أبقِ `MONGODB_URI` في `.env` كما هو | ⭐ **الأفضل**: سرعة محلية + نسخة احتياطية تلقائية |
| ب) محلي فقط | علّق/احذف `MONGODB_URI` | يعمل فوراً، لكن **إلزامي** عمل نسخة يومية (القسم 7) |
| ج) سحابة فقط | غير موصى به للقطاع البري | — |

**إذا اخترت (أ):**
1. في موقع Atlas → Network Access → Add IP: ضع **IP الخادم الجديد** بدلاً من IP منزل ك (أو أضفه بجانبه).
2. **قبل أول إقلاع للسيرفر:** على جهازك المحلي (عندما يكون IP المنزل مازال مسموحاً) شغّل مرة:
   ```
   node -e "require('dotenv').config(); const client=new require('mongodb').MongoClient(process.env.MONGODB_URI); client.connect().then(async()=>{const d=client.db();const cols=await d.listCollections().toArray();for(const c of cols){if(c.name==='meta')continue;await d.collection(c.name).deleteMany({});console.log('cleaned',c.name)}await client.close();console.log('DONE')})"
   ```
   > يمسح **فقط من السحابة** أي بيانات قديمة عالقة (بيانات ما قبل التصفير) حتى لا تنبعث على الخادم الجديد. الاحتفاظ بـ `meta` ضروري لاستمرار عدّادات المعرفات.

3. ارفع `data/db.json` (نظيف) مع المشروع — عند أول إقلاع على السيرفر، سيرى db.js السحابة فارغة ويستورد الملف النظيف تلقائياً.

---

## 4️⃣ ملف الأسرار `.env` — القائمة الكاملة المطلوب ضبطها

```
# ---- الأساسيات (يجب ضبطها في الإنتاج) ----
NODE_ENV=production
CORS_ORIGIN=https://domanek.com
TRUST_PROXY=1

# ---- بيانات الاتصال (من المطور، لا تنشر أبداً) ----
MONGODB_URI=…        # أو علقها إن اخترت (ب)
ADMIN_PASSWORD=…     # ⚠️ غير كلمة مرور الأدمن قبل أي أسبوع من النشر
JWT_SECRET=…         # إن لم تُعرّف تُولد تلقائياً في data/.dev_secret — انقله

# ---- Cloudinary (مستمر) ----
CLOUDINARY_CLOUD_NAME=dfr7t5oup
CLOUDINARY_API_KEY=…
CLOUDINARY_API_SECRET=…

# ---- Kashier (بوابة الدفع) ----
KASHIER_SECRET_KEY=…
KASHIER_API_KEY=…      # احتفظ به — يُستخدم للتوقيع أيضاً
KASHIER_MERCHANT_ID=…

# ---- البريد (SMTP) ----
SMTP_…=…

# ---- الإيرادات (افتراضيات آمنة — اتركها كما هي إلا لسبب) ----
# RECEIPT_AUTO_APPROVE=false   (لا تفعّل — تقرأ الصور لا كشوف الحسابات)
# PENDING_GRANTS_ACCESS=false  (لا تفعّل — يفتح حلقة الاشتراك المجاني)

# ---- حصص ومواصفات ----
VAULT_PASSPHRASE=…    # تستخدمها الخزنة المشفرة — انقلها من بيئة التطوير
```

---

## 5️⃣ تثبيت المكونات على السيرفر (Ubuntu)

```bash
# 1) وقت + لغة (أهم من يظن — الملفات العربية تتحول لنصوص مشوهة بدونه)
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx ffmpeg curl build-essential

# 2) Node 22 (LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3) إدارة العملية
sudo apt install -y pm2
```

**تأكد أن ffmpeg يعمل:** الأمر `ffmpeg -version`
> كودنا يبحث أولاً في مسارات Windows ثم يسقط على `ffmpeg` في PATH — على Linux سيجده تلقائياً.

---

## 6️⃣ تشغيل التطبيق + nginx + SSL

```bash
# أ) رفع المشروع ثم داخل مجلد server:
npm install --omit=dev            # أو نسخ node_modules كاملة
pm2 start server.js --name manara
pm2 save && pm2 startup           # يعيد التشغيل عند Reboot

# ب) ملف nginx: /etc/nginx/sites-available/manara
```
```nginx
server {
    listen 80;
    server_name domanek.com www.domanek.com;

    client_max_body_size 100m;      # 🔴 إلزامي لمقاطع الفيديو

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/manara /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# ج) الشهادة (مجانية + تجديد ذاتي):
sudo certbot --nginx -d domanek.com -d www.domanek.com
```

---

## 7️⃣ النسخ الاحتياطي اليومي (إلزامي — أشد خطورة بعشر مرات من المصدر عندما لا يعمل MongoDB)

```bash
# أضف إلى crontab (crontab -e):
15 3 * * * tar -czf /backups/manara-$(date +\%F).tar.gz /var/www/manara/server/data /var/www/manara/server/uploads
```

---

## 8️⃣ قائمة تحقق قبل فتح الموقع للجمهور

- [ ] `.env` فيه `NODE_ENV=production` و**بلا** `DEV_CODES`
- [ ] IP السيرفر مضاف في Atlas (خيار أ فقط)
- [ ] السحابة فُحصت ومسحت منها أي بيانات قديمة (القسم 3)
- [ ] كلمة مرور الأدمن تغيرت لأقوى من `.env`
- [ ] `jwtSecret`/`.dev_secret` موجود على السيرفر (وإلا كل الجلسات تسقط عند كل إقلاع)
- [ ] HTTPS يعمل (https:// لدومينك يعرض قفل)
- [ ] تجربة مستخدم كامل عبر HTTPS: تسجيل → رفع فيديو → موافقة أدمن → اشتراك
- [ ] cron للنسخ الاحتياطي يعمل
- [ ] `pm2 save` بعد التشغيل المستقر

---

## 9️⃣ أخطاء شائعة وماذا تفعل

| العلامة | السبب | الحل |
|---------|-------|------|
| الفيديو يفشل عند الرفع بـ 413 | `client_max_body_size` غير مضبوط | أضفه في nginx (القسم 6) |
| العربية مشوهة في البيانات | ملفات خُلقت على Windows ترميزاً مختلفاً | انقلها كما هي (UTF-8)، وتأكد أن locale السيرفر UTF-8 |
| 429 على كل الطلبات حتى أنت | `TRUST_PROXY` غير مضبوط — الكل بدلو واحد | أشغل `TRUST_PROXY=1` |
| رموز التحقق تظهر في الاستجابة | `NODE_ENV` غير مضبوطة | القسم 1 |
| البيانات القديمة عادت فجأة | السحابة فيها نسخة قديمة انبعثت | القسم 3 ثم `npm run` أدوات المسح إن وجدت |
| السيرفر لا يعود بعد إعادة تشغيل الخادم | pm2 لم يسجّل `startup` | `pm2 start` ثم `pm2 save && pm2 startup` |

---

*وُثّقت من مراجعة الكود الشاملة. تاريخ الإعداد: 24 أغسطس 2026.*