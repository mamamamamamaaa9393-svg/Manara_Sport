/* Send a real expiry-reminder email to verify SMTP + template work. */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const email = require(path.join(__dirname, "..", "src", "email"));
const to = process.argv[2] || "mamamamamamaaa9393@gmail.com";
console.log("SMTP_HOST:", process.env.SMTP_HOST);
console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("NODE_ENV:", process.env.NODE_ENV);
email.sendSubscriptionExpiring(to, "لاعب اختبار", "العضوية الذهبية", "2026-08-21", "39")
  .then((info) => { console.log("EMAIL SENT OK, messageId:", info && info.messageId); process.exit(0); })
  .catch((e) => { console.error("EMAIL FAILED:", e && e.message); process.exit(1); });