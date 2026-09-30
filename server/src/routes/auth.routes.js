const router = require("express").Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { sign, setAuthCookie, clearAuthCookie, revokeToken, tokenFromRequest } = require("../middleware/auth");
const helpers = require("../helpers");
const { claimUploads } = require("../uploadQuota");
const declarations = require("../declarations");
const cloudinary = require("cloudinary").v2;
const mg = require("../mediaGuard");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

function cloudinaryConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Recursively gather every local /uploads/ URL and Cloudinary asset id
// referenced anywhere inside a stored object (photos, documents, videos...).
function collectUploadUrls(v, set) {
  if (typeof v === "string") {
    if (v.startsWith("/uploads/")) set.add(v);
  } else if (Array.isArray(v)) {
    v.forEach((x) => collectUploadUrls(x, set));
  } else if (v && typeof v === "object") {
    Object.values(v).forEach((x) => collectUploadUrls(x, set));
  }
}
function collectCloudIds(v, set) {
  if (Array.isArray(v)) {
    v.forEach((x) => collectCloudIds(x, set));
  } else if (v && typeof v === "object") {
    if (typeof v.publicId === "string" && v.publicId) set.add(v.publicId);
    Object.values(v).forEach((x) => collectCloudIds(x, set));
  }
}

// SECURITY: OTP codes are echoed back ONLY when explicitly enabled via
// DEV_CODES=1. The email provider is the delivery channel; NODE_ENV alone
// never leaks codes, so an unset/misconfigured NODE_ENV cannot expose them.
const DEV_CODES = process.env.DEV_CODES === "1";

function emailForRole(role, data) {
  const email = role === "player" ? data.email : data.official_email;
  return String(email || "").trim().toLowerCase();
}

function findUserByEmail(email) {
  return db.get().users.find((u) => u.email === email);
}

function findRegistrationByEmail(email) {
  return db.get().registrations.find((r) => r.email === email);
}

function minutesLeft(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 60000));
}

const DOC_LABELS = {
  birth_cert: "شهادة الميلاد",
  medical: "التقرير الطبي",
  declaration: "صورة الإقرار",
  official_letter: "الخطاب الرسمي",
  license: "رخصة النادي / السجل التجاري"
};

// Registration requires the official proof documents to be uploaded. The
// admin reviews those images before the account becomes active.
// NOTE: declaration (صورة الإقرار) was removed from the required list — the
// field is currently disabled for new sign-ups, so a missing declaration must
// NOT block account creation. It stays fully supported when provided.
function missingDoc(role, data) {
  const docs = (data && data.documents && typeof data.documents === "object") ? data.documents : {};
  const required = role === "player"
    ? ["birth_cert", "medical"]
    : ["official_letter", "license"];
  for (const k of required) {
    if (typeof docs[k] !== "string" || !docs[k].trim()) return k;
  }
  return null;
}

// A submitted video URL is only accepted if the server can prove it owns the
// bytes AND that the bytes are a real video. Delegates to mediaGuard, which is
// the single source of truth shared with POST/PUT /api/players (players.routes
// .js) — a bare fs.existsSync here used to let a PDF or a JPEG pass as a
// "video", and let an arbitrary external link through if it happened to name
// any file in /uploads.
function isKnownVideoUrl(url) {
  return mg.isKnownVideoUrl(url);
}

// POST /api/auth/register  { role: "player"|"club", data: { ...form, photo, documents, videos } }
// Files are uploaded beforehand via POST /api/upload/register-upload (no auth
// needed), so `data` carries their public URLs. The account is created in a
// pending state and a registration request is queued for admin review. No
// token is issued until an admin approves the request.
router.post("/register", async (req, res, next) => {
  try {
    const { role } = req.body || {};
    const data = (req.body && req.body.data) || {};
    if (role !== "player" && role !== "club") {
      return res.status(400).json({ error: "نوع الحساب غير صالح — يجب أن يكون «لاعب» أو «نادي»" });
    }
    const email = emailForRole(role, data || {});
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "بريد إلكتروني صالح مطلوب" });
    }
    const password = String(data.password || "");
    if (password.length < 6) {
      return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    }
    if (password !== String(data.password_confirm || "")) {
      return res.status(400).json({ error: "كلمتا المرور غير متطابقتين" });
    }

    // The account name and phone are required fields in the sign-up form, so
    // enforce them server-side too (an empty name previously produced a
    // placeholder profile name).
    const accountName = helpers.clean(role === "club" ? (data.club_name || data.full_name) : data.full_name);
    if (!accountName) {
      return res.status(400).json({ error: role === "club" ? "اسم النادي مطلوب" : "الاسم الكامل مطلوب" });
    }
    if (!helpers.clean(data.phone)) {
      return res.status(400).json({ error: "رقم الهاتف مطلوب" });
    }

    const missing = missingDoc(role, data);
    if (missing) {
      return res.status(400).json({ error: "يرجى إرفاق " + DOC_LABELS[missing] + " — ستراجعها الإدارة قبل تفعيل حسابك" });
    }

    // Email verification check: the email must have been verified via OTP before
    // registration. Once the 6-digit code was successfully matched, the 15-min
    // OTP window served its purpose — we must NOT re-check expiresAt here,
    // because video/document uploads take 5-10+ min and the record would be
    // expired by the time the user hits submit, wrongly rejecting a verified
    // email. The verify-email route already enforced the window + attempt cap
    // at the moment the code was entered, and `verified` can only be set by
    // that successful match, so an unexpired-check is redundant and harmful.
    const store = db.get();
    store.verifications = store.verifications || [];
    const emailVerified = store.verifications.some(
      (v) => v.email === email && v.verified === true
    );
    if (!emailVerified) {
      return res.status(400).json({ error: "يجب التحقق من البريد الإلكتروني أولاً — اضغط \"إرسال رمز التحقق\" وأدخل الرمز المرسل" });
    }

    // A player must attach at least one highlight video (5-15 min). The video
    // itself is validated (duration + no edits) at upload time.
    if (role === "player" && (!Array.isArray(data.videos) || !data.videos.length)) {
      return res.status(400).json({ error: "يجب رفع فيديو واحد على الأقل (من دقيقة واحدة إلى 10 دقائق) لعرض مهاراتك" });
    }

    // Every video referenced must correspond to a real file the server has
    // (a /uploads/ file on disk or an upload record from register-upload).
    // This blocks forged / dead links submitted directly to the API.
    if (role === "player" && Array.isArray(data.videos)) {
      const known = isKnownVideoUrl;
      for (const v of data.videos) {
        if (!known(v && v.url)) {
          return res.status(400).json({ error: "أحد ملفات الفيديو غير موجود في الخادم — أعد رفع الفيديو من صفحة التسجيل" });
        }
      }
    }

    // Email already registered? Distinguish pending / rejected / active.
    const existing = findUserByEmail(email);
    if (existing) {
      const reg = findRegistrationByEmail(email);
      if (!reg || reg.status === "approved" || existing.approved !== false) {
        return res.status(409).json({ error: "يوجد حساب مسجل بهذا البريد بالفعل" });
      }
      if (reg.status === "pending") {
        return res.status(409).json({ error: "تم استلام طلبك مسبقاً — بانتظار مراجعة الإدارة", status: "pending" });
      }
      // Rejected: allow a fresh attempt only after the 15-minute cooldown.
      if (reg.retryAfter && new Date(reg.retryAfter).getTime() > Date.now()) {
        return res.status(429).json({
          error: "تم رفض طلبك السابق — أرفق الملفات بشكل صحيح وأعد المحاولة بعد " + minutesLeft(reg.retryAfter) + " دقيقة",
          status: "rejected",
          retryAfter: reg.retryAfter
        });
      }
      // Cooldown passed -> replace the old rejected account with a fresh one.
      store.users = store.users.filter((u) => u.id !== existing.id);
      store.players = store.players.filter((p) => p.userId !== existing.id);
      store.clubs = store.clubs.filter((c) => c.userId !== existing.id);
      store.registrations = store.registrations.filter((r) => r.id !== reg.id);
    }

    const now = new Date().toISOString();
    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: "u_" + db.nextId("user"),
      role,
      email,
      name: role === "player" ? helpers.clean(data.full_name) : helpers.clean(data.club_name),
      passwordHash: hash,
      approved: false,
      createdAt: now
    };
    store.users.push(user);

    let profile;
    if (role === "player") {
      profile = Object.assign({ id: "p_" + db.nextId("player"), userId: user.id, postedDays: 0, rating: 0, reviews: 0, createdAt: now }, helpers.playerFromForm(data));
      profile.photo = typeof data.photo === "string" ? data.photo : "";
      profile.documents = (data.documents && typeof data.documents === "object") ? data.documents : {};
      store.players.push(profile);
    } else {
      profile = Object.assign({ id: "c_" + db.nextId("club"), userId: user.id, createdAt: now }, helpers.clubFromForm(data));
      profile.documents = (data.documents && typeof data.documents === "object") ? data.documents : {};
      store.clubs.push(profile);
    }

    const safeData = Object.assign({}, data);
    delete safeData.password;
    delete safeData.password_confirm;

    const statusToken = crypto.randomBytes(16).toString("hex");
    const registration = {
      id: "r_" + db.nextId("registration"),
      userId: user.id,
      role,
      email,
      name: user.name,
      status: "pending",
      submittedAt: now,
      reviewedAt: null,
      retryAfter: null,
      adminNote: null,
      statusToken,
      photo: profile.photo || profile.logo || null,
      documents: profile.documents || {},
      videos: Array.isArray(data.videos) ? data.videos : [],
      data: safeData
    };
    store.registrations.push(registration);

    // Claim ownership of every file this registration references (videos,
    // documents, photo) so the 24h orphan sweep can never delete a registered
    // player's/club's media. Without this, a video committed to the profile
    // could be swept later and the profile would point at a dead URL.
    const claimed = [];
    (data.videos || []).forEach((v) => v && v.url && claimed.push(v.url));
    if (profile.photo) claimed.push(profile.photo);
    if (profile.documents && typeof profile.documents === "object") {
      Object.keys(profile.documents).forEach((k) => {
        const u = profile.documents[k];
        if (typeof u === "string") claimed.push(u);
      });
    }
    claimUploads(store, claimed, user.id);

    // Consume the verification record: it is single-use proof of email
    // ownership for THIS registration only. Leaving it behind would let a
    // stale `verified` flag satisfy a brand-new sign-up with the same email
    // months later without ever requesting a new code.
    store.verifications = (store.verifications || []).filter((v) => !(v.email === email && v.verified === true));

    db.save();

    return res.status(201).json({
      status: "pending",
      registrationId: registration.id,
      statusToken,
      message: role === "player"
        ? "تم استلام ملفك الرياضي — بانتظار مراجعة الإدارة"
        : "تم استلام ملف النادي — بانتظار مراجعة الإدارة"
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/status  { email, token }
// Lets a pending applicant poll their request status without logging in
// (their account has no token until an admin approves it). The random
// `statusToken` returned at registration proves they own the request.
router.post("/status", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const token = String(req.body.token || "").trim();
    const reg = findRegistrationByEmail(email);
    if (!reg) {
      return res.status(404).json({ error: "لم يتم العثور على طلب تسجيل بهذا البريد" });
    }
    if (!token || reg.statusToken !== token) {
      return res.status(403).json({ error: "رمز التتبع غير صحيح — تأكد من الرابط المرسل إليك" });
    }
    const msgs = {
      pending: "لا يزال طلبك قيد المراجعة",
      approved: "تم تفعيل حسابك — يمكنك تسجيل الدخول الآن",
      rejected: "تم رفض طلبك — أعد إرسال المستندات الصحيحة"
    };
    return res.json({
      status: reg.status,
      role: reg.role,
      name: reg.name,
      submittedAt: reg.submittedAt,
      reviewedAt: reg.reviewedAt,
      adminNote: reg.adminNote,
      retryAfter: reg.retryAfter,
      message: msgs[reg.status] || msgs.pending
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/send-verification  { email }
// Sends a 6-digit OTP to the given email for verification. Returns a
// verificationId that must be submitted with the code.
router.post("/send-verification", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "بريد إلكتروني صالح مطلوب" });
    }
    const store = db.get();
    const code = String(crypto.randomInt(100000, 1000000));
    const verificationId = "v_" + db.nextId("verification");
    const record = {
      id: verificationId,
      email,
      code,
      attempts: 0,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };
    store.verifications = store.verifications || [];
    store.verifications.push(record);
    db.save();
    let sent = true;
    try {
      const { sendVerificationCode } = require("../email");
      await sendVerificationCode(email, code);
    } catch (e) {
      sent = false;
      console.error("[email] Failed to send verification code:", e.message);
    }
    // In development only: always surface the code in the response (SMTP on
    // or off, JSON store or MongoDB) so tests and manual sign-ups never need
    // the email provider. Production never exposes the code.
    if (DEV_CODES) {
      return res.json({
        verificationId,
        devCode: code,
        message: sent ? "تم إرسال رمز التحقق إلى بريدك الإلكتروني" : "⚠️ لم يصل الرمز عبر البريد (فشل الإرسال). في وضع التطوير، هذا هو رمزك: " + code
      });
    }
    if (!sent) {
      return res.status(500).json({ error: "تعذر إرسال رمز التحقق إلى بريدك الإلكتروني — تحقق من صحة البريد وحاول مرة أخرى لاحقاً" });
    }
    return res.json({ verificationId, message: "تم إرسال رمز التحقق إلى بريدك الإلكتروني" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email  { verificationId, code }
// Verifies the 6-digit OTP. Returns { verified: true } on success.
router.post("/verify-email", (req, res, next) => {
  try {
    const { verificationId, code } = req.body || {};
    if (!verificationId || !code) {
      return res.status(400).json({ error: "معرف التحقق والرمز مطلوبان" });
    }
    const store = db.get();
    store.verifications = store.verifications || [];
    // SECURITY: count every WRONG guess against the record (lookup by id only,
    // compare the code afterwards) so brute-forcing the 6-digit OTP is capped
    // at 5 failures, after which the record is invalidated.
    const record = store.verifications.find((v) => v.id === verificationId);
    if (!record) {
      return res.status(400).json({ error: "معرف التحقق غير صالح — اطلب رمزاً جديداً" });
    }
    if (record.attempts >= 5) {
      store.verifications = store.verifications.filter((v) => v.id !== verificationId);
      db.save();
      return res.status(429).json({ error: "تم تجاوز عدد المحاولات المسموح — اطلب رمزاً جديداً" });
    }
    if (String(record.code) !== String(code).trim()) {
      record.attempts = (record.attempts || 0) + 1;
      db.save();
      return res.status(400).json({
        error: "الرمز غير صحيح" + (record.attempts >= 3 ? " — تنبيه: تبقت " + (5 - record.attempts) + " محاولات فقط" : "")
      });
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ error: "انتهت صلاحية الرمز — اطلب رمزاً جديداً" });
    }
    record.verified = true;
    db.save();
    return res.json({ verified: true, email: record.email, message: "تم التحقق من البريد الإلكتروني بنجاح" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login  { email, password }
// Pending accounts are blocked until an admin approves them. Rejected accounts
// are told to attach the files correctly and to retry after the cooldown.
router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = findUserByEmail(email);

    // Account lockout after 5 failed attempts (15-minute window)
    if (user) {
      const now = Date.now();
      const lockUntil = user.lockedUntil ? new Date(user.lockedUntil).getTime() : 0;
      if (lockUntil > now) {
        const mins = Math.ceil((lockUntil - now) / 60000);
        return res.status(423).json({ error: "تم قفل الحساب مؤقتاً بسبب محاولات كثيرة. حاول بعد " + mins + " دقيقة" });
      }
    }

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      // Track failed attempts
      if (user) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= 5) {
          user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          db.save();
          return res.status(423).json({ error: "تم قفل الحساب لمدة 15 دقيقة بسبب 5 محاولات فاشلة متتالية" });
        }
        db.save();
      }
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Successful login — reset failed attempts
    if (user.failedLoginAttempts) { user.failedLoginAttempts = 0; user.lockedUntil = null; db.save(); }

    if (user.approved === false) {
      const reg = findRegistrationByEmail(email);
      if (reg && reg.status === "rejected") {
        const reason = reg.adminNote ? " (السبب: " + reg.adminNote + ")" : "";
        const wait = reg.retryAfter ? minutesLeft(reg.retryAfter) : 0;
        return res.status(403).json({
          error: "تم رفض طلبك" + reason + " — أرفق الملفات بشكل صحيح وأعد المحاولة بعد " + wait + " دقيقة",
          status: "rejected",
          retryAfter: reg.retryAfter
        });
      }
      return res.status(403).json({
        error: "طلبك قيد المراجعة — ستتمكن من تسجيل الدخول بعد موافقة الإدارة",
        status: "pending"
      });
    }

    const store = db.get();
    const profile = user.role === "player"
      ? store.players.find((p) => p.userId === user.id)
      : store.clubs.find((c) => c.userId === user.id);

    // Set the JWT in an httpOnly cookie (invisible to JavaScript → an XSS
    // payload can never steal it). The token is still echoed in the JSON body
    // so non-browser API clients and the existing test suites keep working.
    const token = sign(user);
    setAuthCookie(res, token);

    return res.json({
      token,
      user: db.publicUser(user),
      profile: profile || null
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout  — clears the httpOnly session cookie.
router.post("/logout", (req, res) => {
  const token = tokenFromRequest(req);
  revokeToken(token);
  clearAuthCookie(res);
  return res.json({ message: "تم تسجيل الخروج" });
});

// GET /api/auth/me  (requires token)
router.get("/me", require("../middleware/auth").requireAuth, (req, res) => {
  const store = db.get();
  const user = store.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const profile = user.role === "player"
    ? store.players.find((p) => p.userId === user.id)
    : store.clubs.find((c) => c.userId === user.id);

  let approval = { status: "approved" };
  if (user.approved === false) {
    const reg = findRegistrationByEmail(user.email);
    approval = { status: reg ? reg.status : "pending" };
  }
  return res.json({ user: db.publicUser(user), profile: db.sanitizePlayer(profile), approval });
});

// POST /api/auth/forgot-password  { email }
// Sends a 6-digit reset code via email. If the email is not registered,
// returns a clear error so the user knows the account doesn't exist.
router.post("/forgot-password", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const store = db.get();
    const user = store.users.find((u) => u.email === email);
    if (!user) {
      return res.status(404).json({ error: "البريد الإلكتروني غير مسجل — أنشئ حساباً أولاً" });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    user.resetToken = code;
    user.resetExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.save();
    let sent = true;
    try {
      const { sendPasswordReset } = require("../email");
      await sendPasswordReset(email, code);
    } catch (e) {
      sent = false;
      console.error("[email] Failed to send reset code:", e.message);
    }
    // In development only: always surface the code in the response (SMTP on
    // or off, JSON store or MongoDB) so the reset flow can still be tested.
    // Production never exposes the code.
    if (DEV_CODES) {
      return res.json({
        devCode: code,
        message: sent ? "تم إرسال رمز إعادة تعيين كلمة المرور إلى بريدك الإلكتروني" : "⚠️ لم يصل الرمز عبر البريد (فشل الإرسال). في وضع التطوير، استخدم الرمز: " + code
      });
    }
    if (!sent) {
      return res.status(500).json({ error: "تعذر إرسال رمز إعادة التعيين إلى بريدك الإلكتروني — حاول مرة أخرى لاحقاً" });
    }
    return res.json({ message: "تم إرسال رمز إعادة تعيين كلمة المرور إلى بريدك الإلكتروني" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password  { code, newPassword, newPasswordConfirm, email? }
router.post("/reset-password", async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = String(body.code || body.token || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const newPassword = body.newPassword;
    const newPasswordConfirm = body.newPasswordConfirm;

    if (!token) {
      return res.status(400).json({ error: "الرمز مطلوب" });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    }
    if (newPassword !== newPasswordConfirm) {
      return res.status(400).json({ error: "كلمتا المرور غير متطابقتين" });
    }

    const store = db.get();
    // Identify the account: prefer email (so failed attempts can be locked to the
    // right user), otherwise fall back to the reset token.
    let user = email ? store.users.find((u) => u.email === email) : null;
    if (!user) user = store.users.find((u) => u.resetToken === token);
    if (!user) {
      return res.status(400).json({ error: "الرمز غير صالح أو منتهي الصلاحية" });
    }

    // Enforce the lock set after too many failed attempts.
    if (user.resetLockedUntil && new Date(user.resetLockedUntil).getTime() > Date.now()) {
      return res.status(429).json({ error: "تم حظر محاولات إعادة التعيين مؤقتاً — حاول مرة أخرى بعد 15 دقيقة" });
    }

    const tokenValid =
      user.resetToken === token &&
      user.resetExpires &&
      new Date(user.resetExpires).getTime() > Date.now();

    if (!tokenValid) {
      // Wrong/expired code = a failed attempt -> lock the account after 3.
      user.resetFailedAttempts = (user.resetFailedAttempts || 0) + 1;
      if (user.resetFailedAttempts >= 3) {
        user.resetLockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      db.save();
      return res.status(400).json({
        error: user.resetLockedUntil
          ? "محاولات كثيرة — تم الحظر 15 دقيقة"
          : "الرمز غير صالح أو منتهي الصلاحية"
      });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    delete user.resetToken;
    delete user.resetExpires;
    delete user.resetFailedAttempts;
    delete user.resetLockedUntil;
    db.save();
    return res.json({ message: "تم إعادة تعيين كلمة المرور بنجاح" });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/account  (requires token — GDPR right to erasure)
// Removes the user record AND every physical file they own (photos, proof
// documents, videos) from local disk and Cloudinary, plus their encrypted
// declaration vault entries — mirroring the admin delete path.
router.delete("/account", require("../middleware/auth").requireAuth, async (req, res, next) => {
  try {
    const store = db.get();
    const userId = req.user.id;

    // Files owned by this account (gathered from all their records before
    // those records are removed).
    const fileUrls = new Set();
    const cloudIds = new Set();
    const collect = (v) => { collectUploadUrls(v, fileUrls); collectCloudIds(v, cloudIds); };
    const myPlayerIds = [];
    store.players.forEach((p) => {
      if (p.userId === userId) {
        myPlayerIds.push(p.id);
        collect(p.photo); collect(p.videos); collect(p.documents);
        collect(p.declaration); collect(p.files);
      }
    });
    store.clubs.forEach((c) => {
      if (c.userId === userId) { collect(c.logo); collect(c.documents); collect(c.declaration); collect(c.files); }
    });
    store.transactions.forEach((t) => { if (t.userId === userId) collect(t.transactionScreenshot); });

    // Applications reference the club by clubUserId and the player by the
    // player profile id — both must be removed with the account.
    store.users = store.users.filter((u) => u.id !== userId);
    store.players = store.players.filter((p) => p.userId !== userId);
    store.clubs = store.clubs.filter((c) => c.userId !== userId);
    store.messages = store.messages.filter((m) => m.fromUserId !== userId && m.toUserId !== userId);
    store.ai_chats = store.ai_chats.filter((ch) => ch.userId !== userId);
    store.transactions = store.transactions.filter((t) => t.userId !== userId);
    store.applications = store.applications.filter((a) =>
      a.clubUserId !== userId && myPlayerIds.indexOf(a.playerId) === -1
    );
    (store.clubs || []).forEach((c) => {
      if (Array.isArray(c.shortlist)) c.shortlist = c.shortlist.filter((id) => !myPlayerIds.includes(id));
      if (c.scoutNotes) myPlayerIds.forEach((pid) => { delete c.scoutNotes[pid]; });
    });
    if (store.uploads) {
      store.uploads = store.uploads.filter((u) => {
        if (u && u.url && fileUrls.has(u.url)) return false;
        return true;
      });
    }
    if (store.reviews) {
      store.reviews = store.reviews.filter((rv) =>
        !myPlayerIds.includes(rv.playerId) && rv.clubUserId !== userId
      );
    }
    if (store.profile_views) {
      store.profile_views = store.profile_views.filter((v) =>
        v.viewerUserId !== userId && !myPlayerIds.includes(v.playerId)
      );
    }
    db.save();

    // Encrypted declaration vault entries for the account's players.
    try {
      myPlayerIds.forEach((pid) => { declarations.removeDeclaration(pid) || 0; });
    } catch (e) {
      console.error("declaration purge failed:", e.message);
    }

    // Physically remove local uploaded files (photos, documents, videos).
    let filesDeleted = 0;
    fileUrls.forEach((u) => {
      const fp = path.join(UPLOAD_DIR, path.basename(u));
      try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); filesDeleted++; } } catch (e) { /* ignore */ }
    });

    // Remove remote Cloudinary video assets (best-effort).
    let cloudDeleted = 0;
    if (cloudIds.size && cloudinaryConfigured()) {
      for (const publicId of cloudIds) {
        try {
          await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
          cloudDeleted++;
        } catch (e) {
          console.error("Cloudinary deletion failed for", publicId, ":", e.message);
        }
      }
    }

    console.log(`[auth] account ${userId} deleted: ${fileUrls.size} local urls, ${filesDeleted} files removed, ${cloudDeleted}/${cloudIds.size} cloud videos removed`);
    clearAuthCookie(res); // the session is gone with the account
    return res.json({ message: "تم حذف حسابك نهائياً" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;