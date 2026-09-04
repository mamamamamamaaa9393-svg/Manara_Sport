/* ==========================================================================
   Manara inquiries (استفسارات).
   - Public: anyone can submit an inquiry (from the contact form) and later
     track it with a secret token. The token is the ONLY key that reveals the
     inquiry + the admin's reply, so each user only sees their own thread.
   - Admin: list open/answered inquiries and post a reply.
   ========================================================================== */
const router = require("express").Router();
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const helpers = require("../helpers");
const crypto = require("crypto");

function findInquiry(id) {
  return db.get().inquiries.find((i) => String(i.id) === String(id));
}
function findByToken(token) {
  return db.get().inquiries.find((i) => i.token === token);
}

const SUBJECTS = ["general", "support", "partnership", "billing", "feedback", "other"];

// POST /api/inquiries  (public, no auth)
router.post("/", (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};
  const cleanName = String(name || "").trim();
  const cleanEmail = String(email || "").trim();
  const cleanMsg = String(message || "").trim();
  if (!cleanName || !cleanEmail || !cleanMsg) {
    return res.status(400).json({ error: "الاسم والبريد الإلكتروني والرسالة مطلوبة" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "البريد الإلكتروني غير صالح" });
  }
  const subj = SUBJECTS.includes(subject) ? subject : "general";

  const store = db.get();
  const id = db.nextId("inquiry");
  const token = crypto.randomBytes(18).toString("hex"); // secret tracking key
  const inquiry = {
    id: id,
    token: token,
    name: cleanName,
    email: cleanEmail,
    phone: phone ? String(phone).trim() : "",
    subject: subj,
    message: cleanMsg,
    status: "open", // open | answered
    reply: null,
    repliedAt: null,
    repliedBy: null,
    createdAt: new Date().toISOString()
  };
  store.inquiries.push(inquiry);
  db.save();

  res.status(201).json({
    id: id,
    token: token,
    trackUrl: "/inquiry-track.html?token=" + encodeURIComponent(token),
    message: "تم استلام استفسارك — احتفظ برابط التتبّع لمتابعة الرد"
  });
});

// GET /api/inquiries/track/:token  (public, token-gated)
router.get("/track/:token", (req, res) => {
  const inquiry = findByToken(req.params.token);
  if (!inquiry) return res.status(404).json({ error: "الاستفسار غير موجود" });
  res.json({
    id: inquiry.id,
    subject: inquiry.subject,
    name: inquiry.name,
    message: inquiry.message,
    reply: inquiry.reply,
    status: inquiry.status,
    createdAt: inquiry.createdAt,
    repliedAt: inquiry.repliedAt
  });
});

// GET /api/admin/inquiries?status=open|answered|all  (admin only)
router.get("/", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  let list = store.inquiries.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const status = req.query.status;
  if (status && status !== "all") list = list.filter((i) => i.status === status);
  const counts = {
    open: store.inquiries.filter((i) => i.status === "open").length,
    answered: store.inquiries.filter((i) => i.status === "answered").length
  };
  res.json({ inquiries: list, counts });
});

// GET /api/admin/inquiries/:id  (admin only)
router.get("/:id", requireAuth, requireAdmin, (req, res) => {
  const inquiry = findInquiry(req.params.id);
  if (!inquiry) return res.status(404).json({ error: "الاستفسار غير موجود" });
  res.json({ inquiry });
});

// POST /api/admin/inquiries/:id/reply  (admin only)
router.post("/:id/reply", requireAuth, requireAdmin, (req, res) => {
  const inquiry = findInquiry(req.params.id);
  if (!inquiry) return res.status(404).json({ error: "الاستفسار غير موجود" });
  const reply = String((req.body && req.body.reply) || "").trim();
  if (!reply) return res.status(400).json({ error: "الرد لا يمكن أن يكون فارغاً" });
  inquiry.reply = reply;
  inquiry.status = "answered";
  inquiry.repliedAt = new Date().toISOString();
  inquiry.repliedBy = (req.user && (req.user.name || req.user.email)) || "admin";
  db.save();
  res.json({ inquiry });
});

module.exports = router;
