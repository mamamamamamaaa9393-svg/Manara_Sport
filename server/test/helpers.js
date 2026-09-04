/* Shared test helpers — keep E2E tests independent of the storage backend
   (MongoDB Atlas vs JSON file) and of whether SMTP delivery actually works:
   OTP codes are read from the dev response (devCode), which the server now
   returns in development regardless of email send success, with a fallback
   to the JSON file store. */
const fs = require("fs");
const path = require("path");

function db() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
}

function otpFrom(sv) {
  if (sv && sv.data && sv.data.devCode) return sv.data.devCode;
  const vId = sv && sv.data && sv.data.verificationId;
  if (vId) {
    const rec = (db().verifications || []).find((v) => v.id === vId);
    if (rec) return rec.code;
  }
  return null;
}

module.exports = { db, otpFrom };