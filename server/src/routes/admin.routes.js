const router = require("express").Router();
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { requireAuth, requireAdmin, SECRET } = require("../middleware/auth");
const declarations = require("../declarations");
const sub = require("../subscription");
const cloudinary = require("cloudinary").v2;

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

function cloudinaryConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Recursively find every Cloudinary asset id (videos) referenced inside an object.
function collectCloudIds(v, set) {
  if (Array.isArray(v)) {
    v.forEach((x) => collectCloudIds(x, set));
  } else if (v && typeof v === "object") {
    if (typeof v.publicId === "string" && v.publicId) set.add(v.publicId);
    Object.values(v).forEach((x) => collectCloudIds(x, set));
  }
}

const REVIEW_COOLDOWN_MS = 15 * 60 * 1000; // player waits 15 min before retrying after a rejection

declarations.init();

function findReg(id) {
  return db.get().registrations.find((r) => r.id === id);
}

// GET /api/admin/registrations?status=pending|approved|rejected|all  (admin only)
router.get("/registrations", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  let list = store.registrations.slice().sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  const status = req.query.status;
  if (status && status !== "all") list = list.filter((r) => r.status === status);
  const counts = {
    pending: store.registrations.filter((r) => r.status === "pending").length,
    approved: store.registrations.filter((r) => r.status === "approved").length,
    rejected: store.registrations.filter((r) => r.status === "rejected").length
  };
  res.json({ registrations: list, counts });
});

// POST /api/admin/registrations/:id/approve — activates the account normally
router.post("/registrations/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  const store = db.get();
  const reg = findReg(req.params.id);
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (reg.status === "approved") return res.status(400).json({ error: "This request is already approved" });
  const user = store.users.find((u) => u.id === reg.userId);
  if (!user) return res.status(404).json({ error: "Account not found" });
  reg.status = "approved";
  reg.reviewedAt = new Date().toISOString();
  reg.adminNote = null;
  user.approved = true;

  // Identity verification: the admin reviewed the official documents —
  // mark the profile verified so the "معتمد" badge shows for approved
  // accounts (and seeded demo profiles, which carry verified: true).
  const profile = reg.role === "player"
    ? store.players.find((p) => p.userId === user.id)
    : store.clubs.find((c) => c.userId === user.id);
  if (profile) profile.verified = true;

  // The free trial starts the moment the account gains access.
  // (Backend server clock is the source of truth.)
  if (!user.trialStart && user.role !== "admin") {
    sub.startTrial(user);
  }

  // Capture a copy of the player's declaration into the encrypted vault.
  // Best-effort: never block the approval because of the vault.
  if (reg.role === "player") {
    try {
      // Link by the PLAYER PROFILE id (p_*) when it exists — storing the
      // user id (u_*) here mislabeled the vault index for consumers.
      const prof = (store.players || []).find((p) => p.userId === user.id);
      declarations.storeDeclaration({
        playerId: prof ? prof.id : user.id,
        playerName: reg.name || (reg.data && reg.data.full_name) || "رياضي",
        approvedAt: reg.reviewedAt,
        declarationUrl: reg.documents && reg.documents.declaration
      });
    } catch (e) {
      console.error("Declaration vault store failed:", e.message);
    }
  }

  db.save();
  try {
    const { sendRegistrationApproved } = require("../email");
    await sendRegistrationApproved(user.email, reg.name);
  } catch (e) { console.error("[email] approve notify failed:", e.message); }
  return res.json({ message: "تمت الموافقة على الطلب — الحساب أصبح نشطاً الآن", registration: reg });
});

// POST /api/admin/registrations/:id/reject  { note }
// The player sees "attach the files correctly" and must wait 15 minutes
// before submitting a new request.
router.post("/registrations/:id/reject", requireAuth, requireAdmin, async (req, res) => {
  const reg = findReg(req.params.id);
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  const note = String((req.body && req.body.note) || "").trim().slice(0, 200);
  reg.status = "rejected";
  reg.reviewedAt = new Date().toISOString();
  reg.retryAfter = new Date(Date.now() + REVIEW_COOLDOWN_MS).toISOString();
  reg.adminNote = note || "الملفات غير صحيحة";
  db.save();
  try {
    const { sendRegistrationRejected } = require("../email");
    await sendRegistrationRejected(reg.email, reg.name, note);
  } catch (e) { console.error("[email] reject notify failed:", e.message); }
  return res.json({ message: "تم رفض الطلب — سيُطلب من مقدم الطلب إرفاق الملفات بشكل صحيح وإعادة المحاولة بعد 15 دقيقة", registration: reg });
});

/* ==========================================================================
   Subscription payments review (gamer 39 EGP / club 299 EGP).
   Egyptian wallets (Vodafone Cash / InstaPay / Fawry) are person-to-person
   transfers: the admin verifies the uploaded transaction screenshot.
   Approving unlocks the subscription (+30 days from expiry or now) and
   reveals the gamer's pending AI replies.
   ========================================================================== */

function findTx(id) {
  return db.get().transactions.find((t) => t.id === id);
}

// GET /api/admin/transactions?status=pending|approved|rejected|all  (admin only)
router.get("/transactions", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  // Auto-cancel stale pending receipts so the review queue stays fresh.
  sub.expireStalePending(store, Date.now());
  // The pending review queue shows the OLDEST request first (FIFO) so nothing
  // sits unreviewed; every other list stays newest-first.
  let list = store.transactions.slice().sort((a, b) =>
    new Date(a.createdAt) - new Date(b.createdAt)
  );
  const status = req.query.status;
  if (status && status !== "all") list = list.filter((t) => t.status === status);
  if (status !== "pending") {
    list = list.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  const counts = {
    pending: store.transactions.filter((t) => t.status === "pending").length,
    approved: store.transactions.filter((t) => t.status === "approved").length,
    rejected: store.transactions.filter((t) => t.status === "rejected").length
  };
  // Drain one-shot admin notifications (e.g. "new manual receipt needs review").
  const admin = store.users.find((u) => u.id === req.user.id);
  const notifications = (admin && admin.pendingNotifications) || [];
  if (admin) admin.pendingNotifications = [];
  if (notifications.length) db.save();
  res.json({ transactions: list, counts, notifications });
});

// POST /api/admin/transactions/:id/approve — idempotent unlock
router.post("/transactions/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const tx = findTx(req.params.id);
  if (!tx) return res.status(404).json({ error: "Transaction not found" });
  if (tx.status !== "pending") {
    return res.status(409).json({ error: "This transaction was already processed" });
  }
  const user = store.users.find((u) => u.id === tx.userId);
  if (!user) return res.status(404).json({ error: "Account not found" });

  tx.status = "approved";
  tx.reviewedAt = new Date().toISOString();
  tx.adminNote = null;

  // Verified payment -> activate / renew the monthly subscription.
  // Extends from the current expiry if still in the future, otherwise from now.
  const base = db.isSubActive(user) ? user.subscriptionExpiresAt : new Date().toISOString();
  sub.activateSubscription(user, { from: base, plan: sub.userTypeOf(user) });
  const next = new Date(user.subscriptionExpiresAt);

  // Reveal the gamer's pending AI replies that were waiting on this payment.
  store.ai_chats
    .filter((m) => m.user_id === user.id && m.is_revealed === false)
    .forEach((m) => { m.is_revealed = true; });

  sub.notify(user, "✅ تمت الموافقة على طلب الدفع #" + tx.id,
    "تم التحقق من الإيصال — اشتراكك مفعّل حتى " + next.toLocaleDateString("ar-EG") + ".");

  db.save();
  return res.json({
    message: "تمت الموافقة على الدفع — الاشتراك مفعّل حتى " + next.toLocaleDateString("ar-EG"),
    transaction: tx,
    subscriptionExpiresAt: user.subscriptionExpiresAt
  });
});

// POST /api/admin/transactions/:id/reject  { note }
router.post("/transactions/:id/reject", requireAuth, requireAdmin, (req, res) => {
  const store = db.get();
  const tx = findTx(req.params.id);
  if (!tx) return res.status(404).json({ error: "Transaction not found" });
  if (tx.status !== "pending") {
    return res.status(409).json({ error: "This transaction was already processed" });
  }
  const note = String((req.body && req.body.note) || "").trim().slice(0, 200);
  tx.status = "rejected";
  tx.reviewedAt = new Date().toISOString();
  tx.adminNote = note || "الإيصال غير صحيح أو المبلغ غير مطابق";

  const user = store.users.find((u) => u.id === tx.userId);
  if (user && !db.isSubActive(user)) user.subscriptionStatus = "inactive";
  if (user) {
    sub.notify(user, "❌ تم رفض طلب الدفع #" + tx.id,
      (note || "الإيصال غير صحيح") + " — يمكنك إرسال طلب جديد بإيصال صحيح.");
  }
  db.save();
  return res.json({
    message: "تم رفض طلب الدفع — " + (note || "الإيصال غير صحيح"),
    transaction: tx
  });
});

/* ==========================================================================
   Encrypted declaration vault (admin-only, 3-word passphrase gate).
   ========================================================================== */

// GET /api/admin/declarations/status — vault configured? how many stored?
router.get("/declarations/status", requireAuth, requireAdmin, (req, res) => {
  res.json(declarations.status());
});

// POST /api/admin/declarations/unlock  { p1, p2, p3 }
// Verifies the 3-word passphrase against the vault probe. On success returns a
// short-lived session token used only to fetch the (decrypted) declaration
// files, so the passphrase is never re-sent for every image.
router.post("/declarations/unlock", requireAuth, requireAdmin, (req, res) => {
  const ok = declarations.verify(req.body.p1, req.body.p2, req.body.p3);
  if (!ok) {
    return res.status(403).json({ error: "كلمات المرور غير صحيحة — تأكد من العبارة السرية الثلاثية بالترتيب الصحيح" });
  }
  const token = jwt.sign({ scope: "declarations" }, SECRET, { expiresIn: "15m" });
  res.json({ token, list: declarations.list() });
});

// GET /api/admin/declarations/:id — fetch one decrypted declaration (image/PDF)
router.get("/declarations/:id", requireAuth, requireAdmin, (req, res) => {
  const tok = req.get("x-decl-token") || "";
  try {
    const payload = jwt.verify(tok, SECRET);
    if (!payload || payload.scope !== "declarations") throw new Error("bad scope");
  } catch (e) {
    return res.status(401).json({ error: "جلسة الخزنة غير صالحة — أعد فتح الخزنة" });
  }
  const out = declarations.readDeclaration(req.params.id);
  if (!out) return res.status(404).json({ error: "لم يتم العثور على الإقرار" });
  res.set("Content-Type", out.mimetype);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  return res.send(out.data);
});

/* ==========================================================================
   Permanent account deletion (admin only).
   Deletes the targeted user AND every piece of data tied to that account:
   player/club profiles, uploaded images/videos/documents, messages,
   registrations, transactions + receipts, reviews, profile views, AI chats,
   applications, shortlist/scout-note references and the encrypted declaration
   vault entries. Local /uploads files are physically removed from disk.
   Safety: an admin account can never be deleted, and an admin cannot delete
   their own account (avoids lockout).
   ========================================================================== */

function collectUploadUrls(v, set) {
  if (typeof v === "string") {
    if (v.startsWith("/uploads/")) set.add(v);
  } else if (Array.isArray(v)) {
    v.forEach((x) => collectUploadUrls(x, set));
  } else if (v && typeof v === "object") {
    Object.values(v).forEach((x) => collectUploadUrls(x, set));
  }
}

router.delete("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const store = db.get();
  const uid = req.params.id;
  const target = store.users.find((u) => u.id === uid);
  if (!target) return res.status(404).json({ error: "Account not found" });
  if (target.role === "admin") return res.status(403).json({ error: "لا يمكن حذف حساب مشرف" });
  if (req.user && req.user.id === uid) return res.status(403).json({ error: "لا يمكنك حذف حسابك بنفسك" });

  const removed = {
    players: 0, clubs: 0, messages: 0, registrations: 0, transactions: 0,
    reviews: 0, profileViews: 0, aiChats: 0, applications: 0, uploads: 0, declarations: 0
  };
  const fileUrls = new Set();
  const cloudIds = new Set();
  const collect = (v) => { collectUploadUrls(v, fileUrls); collectCloudIds(v, cloudIds); };

  // Player profiles owned by the user (+ their files)
  const playerIds = new Set();
  store.players = (store.players || []).filter((p) => {
    if (p.userId === uid) {
      playerIds.add(p.id);
      collect(p.photo); collect(p.videos); collect(p.documents);
      collect(p.declaration); collect(p.files);
      removed.players++; return false;
    }
    return true;
  });

  // Club profiles owned by the user (+ their files)
  store.clubs = (store.clubs || []).filter((c) => {
    if (c.userId === uid) {
      collect(c.logo); collect(c.documents); collect(c.declaration); collect(c.files);
      removed.clubs++; return false;
    }
    return true;
  });

  // Messages where the user is sender or recipient
  store.messages = (store.messages || []).filter((m) => {
    if (m.fromUserId === uid || m.toUserId === uid) { removed.messages++; return false; }
    return true;
  });

  // Registration requests for this account
  store.registrations = (store.registrations || []).filter((r) => {
    if (r.userId === uid) { removed.registrations++; return false; }
    return true;
  });

  // Payment transactions + receipt files
  store.transactions = (store.transactions || []).filter((t) => {
    if (t.userId === uid) { collect(t.transactionScreenshot); removed.transactions++; return false; }
    return true;
  });

  // Reviews about the user's players or written by the user's club
  store.reviews = (store.reviews || []).filter((rv) => {
    if (playerIds.has(rv.playerId) || rv.clubUserId === uid) { removed.reviews++; return false; }
    return true;
  });

  // Profile-view tracking
  store.profile_views = (store.profile_views || []).filter((v) => {
    if (v.viewerUserId === uid || playerIds.has(v.playerId)) { removed.profileViews++; return false; }
    return true;
  });

  // AI assistant chat history
  store.ai_chats = (store.ai_chats || []).filter((ch) => {
    if (ch.user_id === uid) { removed.aiChats++; return false; }
    return true;
  });

  // Applications referencing the user's players / club
  store.applications = (store.applications || []).filter((a) => {
    if (playerIds.has(a.playerId) || a.clubUserId === uid) { removed.applications++; return false; }
    return true;
  });

  // Shortlist + scout-note references to the deleted players (in other clubs)
  (store.clubs || []).forEach((c) => {
    if (Array.isArray(c.shortlist)) c.shortlist = c.shortlist.filter((id) => !playerIds.has(id));
    if (c.scoutNotes) playerIds.forEach((pid) => { delete c.scoutNotes[pid]; });
  });

  // Uploads metadata
  if (store.uploads) {
    store.uploads = store.uploads.filter((u) => {
      if (u && u.url && fileUrls.has(u.url)) { removed.uploads++; return false; }
      return true;
    });
  }

  // Encrypted declaration vault entries for the deleted players
  try {
    playerIds.forEach((pid) => { removed.declarations += declarations.removeDeclaration(pid) || 0; });
  } catch (e) { console.error("declaration purge failed:", e.message); }

  // Physically remove local uploaded files
  let filesDeleted = 0;
  fileUrls.forEach((u) => {
    const fp = path.join(UPLOAD_DIR, path.basename(u));
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); filesDeleted++; } } catch (e) { /* ignore */ }
  });

  // Remove remote Cloudinary video assets (best-effort; skipped if Cloudinary
  // is not configured or the asset is already gone).
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

  // Finally remove the account itself
  store.users = store.users.filter((u) => u.id !== uid);
  db.save();

  // Audit log: who deleted what, when, and what was purged.
  try {
    const logs = (store.admin_logs = store.admin_logs || []);
    logs.push({
      id: "log_" + db.nextId("admin_log"),
      action: "DELETE_USER",
      adminId: req.user.id,
      adminName: req.user.name || "",
      targetUserId: uid,
      targetName: target.name || "",
      targetEmail: target.email || "",
      targetRole: target.role || "",
      timestamp: new Date().toISOString(),
      deleted: removed,
      filesDeleted,
      cloudDeleted
    });
    db.save();
  } catch (e) { console.error("audit log write failed:", e.message); }

  return res.json({
    message: "تم حذف الحساب وكل بياناته المرتبطة به نهائياً",
    deleted: removed,
    filesDeleted,
    cloudDeleted
  });
});

// GET /api/admin/logs — administrative audit trail (admin only, most recent first)
router.get("/logs", requireAuth, requireAdmin, (req, res) => {
  const logs = (db.get().admin_logs || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ logs });
});

module.exports = router;