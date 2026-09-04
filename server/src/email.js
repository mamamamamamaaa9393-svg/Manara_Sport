/* ==========================================================================
   Manara — Email service (Nodemailer).
   Uses Ethereal test account in development; real SMTP in production.
   Configure via env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
   ========================================================================== */
const nodemailer = require("nodemailer");

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  const isDev = process.env.NODE_ENV !== "production";

  if (isDev && !process.env.SMTP_HOST) {
    const test = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: test.smtp.host,
      port: test.smtp.port,
      secure: test.smtp.secure,
      auth: { user: test.user, pass: test.pass }
    });
    console.log("[email] Ethereal test account:", test.user);
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

function fromAddress() {
  return process.env.SMTP_FROM || "Manara <no-reply@manara.app>";
}

async function sendMail({ to, subject, html, text }) {
  const transport = await getTransporter();
  const info = await transport.sendMail({
    from: fromAddress(),
    to,
    subject,
    html,
    text: text || subject
  });
  if (process.env.NODE_ENV !== "production") {
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log("[email] Preview URL:", preview);
  }
  return info;
}

// --- Templated emails ---

async function sendPasswordReset(to, code) {
  return sendMail({
    to,
    subject: "Manara — رمز إعادة تعيين كلمة المرور",
    html: `
      <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#0ea5e9;">Manara — إعادة تعيين كلمة المرور</h2>
        <p>مرحباً،</p>
        <p>تلقينا طلباً لإعادة تعيين كلمة المرور لحسابك. استخدم الرمز التالي:</p>
        <div style="background:#f1f5f9;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
          <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#0ea5e9;">${code}</span>
        </div>
        <p style="color:#64748b;font-size:13px;">هذا الرمز صالح لمدة <strong>15 دقيقة</strong> فقط. إذا لم تطلب إعادة التعيين، تجاهل هذا البريد.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
        <p style="color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Manara — منصة اكتشاف المواهب الرياضية</p>
      </div>
    `
  });
}

async function sendVerificationCode(to, code) {
  return sendMail({
    to,
    subject: "Manara — التحقق من البريد الإلكتروني",
    html: `
      <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#0ea5e9;">Manara — التحقق من البريد</h2>
        <p>مرحباً،</p>
        <p>لقد سجلت حساباً على منصة Manara. استخدم الرمز التالي للتحقق من بريدك الإلكتروني:</p>
        <div style="background:#f1f5f9;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
          <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#0ea5e9;">${code}</span>
        </div>
        <p style="color:#64748b;font-size:13px;">هذا الرمز صالح لمدة <strong>15 دقيقة</strong> فقط.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
        <p style="color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Manara — منصة اكتشاف المواهب الرياضية</p>
      </div>
    `
  });
}

async function sendRegistrationApproved(to, name) {
  return sendMail({
    to,
    subject: "Manara — تم الموافقة على حسابك",
    html: `
      <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#22c55e;">تمت الموافقة على حسابك!</h2>
        <p>مرحباً ${name || ""}،</p>
        <p>تمت مراجعة طلب التسجيل الخاص بك والموافقة عليه. يمكنك الآن تسجيل الدخول والبدء في استخدام المنصة.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${process.env.SITE_URL || "http://localhost:5000"}/Sign/Sign_In.html"
             style="background:#0ea5e9;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;">تسجيل الدخول</a>
        </div>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
        <p style="color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Manara — منصة اكتشاف المواهب الرياضية</p>
      </div>
    `
  });
}

async function sendRegistrationRejected(to, name, reason) {
  return sendMail({
    to,
    subject: "Manara — تم رفض طلب التسجيل",
    html: `
      <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#ef4444;">تم رفض طلب التسجيل</h2>
        <p>مرحباً ${name || ""}،</p>
        <p>نأسف لإبلاغك بأنه تمت مراجعة طلب التسجيل الخاص بك وتم رفضه.</p>
        ${reason ? `<p style="color:#64748b;"><strong>السبب:</strong> ${reason}</p>` : ""}
        <p>يمكنك تعديل بياناتك وإعادة المحاولة بعد 15 دقيقة.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
        <p style="color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Manara — منصة اكتشاف المواهب الرياضية</p>
      </div>
    `
  });
}

async function sendSubscriptionExpiring(to, name, planLabel, endDate, price) {
  return sendMail({
    to,
    subject: "Manara — اشتراكك على وشك الانتهاء",
    html: `
      <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#0ea5e9;">اشتراكك على وشك الانتهاء ⏳</h2>
        <p>مرحباً ${name || ""}،</p>
        <p>نود إخبارك أن اشتراكك في منصة <strong>منارة</strong> سينتهي قريباً.</p>
        <div style="background:#f1f5f9;border-radius:10px;padding:16px;margin:18px 0;">
          <p style="margin:0 0 6px;"><strong>الخطة:</strong> ${planLabel || ""}</p>
          <p style="margin:0 0 6px;"><strong>نهاية الفترة:</strong> ${endDate || "—"}</p>
          <p style="margin:0;"><strong>السعر:</strong> ${price || "—"} ج.م / شهرياً</p>
        </div>
        <p>لتجديد اشتراكك ومواصلة الاستفادة من جميع المزايا دون انقطاع، يرجى إتمام الدفع عبر المحافظ المصرية (فودافون كاش / فوري) قبل انتهاء الفترة.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${process.env.SITE_URL || "http://localhost:5000"}/subscribe.html"
             style="background:#0ea5e9;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;">تجديد الاشتراك</a>
        </div>
        <p style="color:#64748b;font-size:13px;">إذا كنت قد جددت اشتراكك بالفعل، يمكنك تجاهل هذه الرسالة.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
        <p style="color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Manara — منصة اكتشاف المواهب الرياضية</p>
      </div>
    `
  });
}

module.exports = {
  sendMail,
  sendPasswordReset,
  sendVerificationCode,
  sendRegistrationApproved,
  sendRegistrationRejected,
  sendSubscriptionExpiring
};
