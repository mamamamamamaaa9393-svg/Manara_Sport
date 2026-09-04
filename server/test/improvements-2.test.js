/* Live E2E test — round 2 improvements:
   - OCR field extraction on real Vodafone Cash / Fawry receipt text (unit)
   - Message unread badge (unread-count -> read on fetch)
   - Admin notification when a manual receipt needs review + FIFO pending sort
   - Club shortlist (add/remove + club detail + compare data)
   - Private scout notes
   - Players sort=rating
   - Video poster thumbnail generation (FFmpeg frame -> <video>.jpg)
   Requires the server on localhost:5000 (restart before running to clear the
   payment rate limiter) and the mobile_test.mov fixture in temp. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = "http://localhost:5000";
const ROOT = path.join(__dirname, "..");
const MOV = "C:\\Users\\pc1\\AppData\\Local\\Temp\\opencode\\mobile_test.mov";
const ADMIN = { email: "admin@manara.app", password: "AAMzTqUix%GFxa8DYS" };

const { otpFrom } = require("./helpers");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: "localhost", port: 5000, path: p, headers: { "Content-Type": "application/json", "Accept": "application/json" } };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, raw: d }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

function upload(filePath, purpose, mime, token) {
  return new Promise((resolve, reject) => {
    const b = fs.readFileSync(filePath);
    const boundary = "----manara" + crypto.randomBytes(8).toString("hex");
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, b, tail]);
    const opts = { method: "POST", hostname: "localhost", port: 5000, path: "/api/upload", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Accept": "application/json" } };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const r = http.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, data: j, raw: d }); });
    });
    r.on("error", reject); r.end(body);
  });
}

async function makeAccount(role, tag, sportData) {
  const email = "test_r2_" + tag + "_" + Date.now() + "@test.com";
  const pass = "TestPass123!";
  const sv = await req("POST", "/api/auth/send-verification", { email });
  if (sv.status !== 200 || !sv.data || !sv.data.verificationId) throw new Error("send-verification failed: " + sv.raw);
  const code = otpFrom(sv);
  if (!code) throw new Error("no OTP");
  await req("POST", "/api/auth/verify-email", { verificationId: sv.data.verificationId, code });
  const data = role === "club"
    ? { full_name: "R2 Club " + tag, official_email: email, password: pass, password_confirm: pass, sport: "Football", club_type: "نادي محترف",
        documents: { official_letter: "/uploads/a.jpg", license: "/uploads/b.jpg" } }
    : Object.assign({ full_name: "R2 Player " + tag, email, password: pass, password_confirm: pass, sport: "Football", position: "ST",
        documents: { birth_cert: "/uploads/a.jpg", medical: "/uploads/b.jpg", declaration: "/uploads/c.jpg" },
        videos: [{ url: "/uploads/ph.mp4", name: "ph.mp4" }] }, sportData || {});
  const reg = await req("POST", "/api/auth/register", { role, data });
  if (reg.status !== 201 || !reg.data || !reg.data.registrationId) throw new Error("register failed: " + reg.raw);
  const admin = await req("POST", "/api/auth/login", { email: ADMIN.email, password: ADMIN.password });
  const app = await req("POST", "/api/admin/registrations/" + reg.data.registrationId + "/approve", {}, admin.data.token);
  if (app.status !== 200) throw new Error("approve failed: " + app.raw);
  const login = await req("POST", "/api/auth/login", { email, password: pass });
  if (login.status !== 200 || !login.data || !login.data.token) throw new Error("login failed: " + login.raw);
  const me = await req("GET", "/api/auth/me", null, login.data.token);
  return {
    email,
    token: login.data.token,
    id: login.data.user && login.data.user.id,
    profileId: me.data && me.data.profile && me.data.profile.id
  };
}

async function run() {
  console.log("\n=== Round-2 improvements E2E test ===\n");

  // ---------- A. OCR extraction (realistic Vodafone Cash / Fawry text) ----------
  console.log("[A] OCR field extraction");
  const ocr = require("../src/receiptOcr");
  const vc = "خدمة فودافون كاش\nمرحباً بك\nالمرسل إليه: 01229409393\nالمبلغ: 10.00 جنيه\nرقم العملية: 1765490035218874\nالتاريخ: 2025-08-18 14:32:05";
  const vf = ocr.parseOcr(vc);
  ok("Vodafone amount", vf.amount === 10, vf);
  ok("Vodafone destination (keyword-aware)", vf.destinationNumber === "01229409393", vf);
  ok("Vodafone reference", vf.referenceNumber === "1765490035218874", vf);
  ok("Vodafone date", vf.date === "2025-08-18", vf);

  const sender = "المرسل من: 01123456789\nالمرسل إليه: 01229409393\nالمبلغ: 200 جنيه\nرقم العملية: 9988776655443322";
  const sf = ocr.parseOcr(sender);
  ok("sender/destination disambiguated", sf.destinationNumber === "01229409393", sf);

  const fawry = "فوري - Fawry\nالمرسل إليه\nالمبلغ المدفوع: 200.00 جنيه\nالمرجع: FR1185470\nالتاريخ: 18/08/2025";
  const ff = ocr.parseOcr(fawry);
  ok("Fawry amount", ff.amount === 200, ff);
  ok("Fawry reference (FR stripped)", ff.referenceNumber === "1185470", ff);
  ok("Fawry date", ff.date === "2025-08-18", ff);

  const aind = "المبلغ: ١٠٫٠٠ جنيه\nالمرسل إليه: 01229409393\nرقم العملية: 555666777888999";
  const af = ocr.parseOcr(aind);
  ok("Arabic-Indic digits amount", af.amount === 10, af);
  ok("Arabic-Indic digits destination", af.destinationNumber === "01229409393", af);

  // ---------- accounts ----------
  const club = await makeAccount("club", "C");
  const player = await makeAccount("player", "P");
  const player2 = await makeAccount("player", "P2");
  const playerId = player.profileId;
  const player2Id = player2.profileId;
  const clubId = club.profileId;
  ok("club + player accounts ready", !!(playerId && player2Id && clubId), { playerId, player2Id, clubId });

  // ---------- B. Message unread badge ----------
  console.log("[B] Message unread badge");
  const meP = await req("GET", "/api/auth/me", null, player.token);
  const playerUserId = meP.data && meP.data.user && meP.data.user.id;
  const sent = await req("POST", "/api/messages", { toUserId: playerUserId, playerId, text: "أهلاً بك من النادي" }, club.token);
  ok("club -> player message sent", sent.status === 201, sent);
  const uc1 = await req("GET", "/api/messages/unread-count", null, player.token);
  ok("player unread-count = 1", uc1.status === 200 && uc1.data.count === 1, uc1.data);
  const conv = await req("GET", "/api/messages?to=" + club.id + "&player=" + playerId, null, player.token);
  ok("player opens conversation", conv.status === 200 && conv.data.messages && conv.data.messages.length === 1, conv.data);
  const uc2 = await req("GET", "/api/messages/unread-count", null, player.token);
  ok("unread cleared after reading", uc2.data.count === 0, uc2.data);

  // ---------- C. Admin notification + FIFO pending sort ----------
  console.log("[C] Admin manual-receipt notification + FIFO");
  const m1 = await req("POST", "/api/subscription/submit-payment", { method: "fawry", referenceNumber: "R2A-" + Date.now(), screenshotUrl: "/uploads/does_not_exist_r2_" + Date.now() + ".png", amount: 39 }, player.token);
  ok("player A manual payment queued", m1.status === 201 && m1.data && m1.data.autoApproved === false, m1.data);
  await new Promise((r) => setTimeout(r, 300));
  const m2 = await req("POST", "/api/subscription/submit-payment", { method: "fawry", referenceNumber: "R2B-" + Date.now(), screenshotUrl: "/uploads/does_not_exist_r2b_" + Date.now() + ".png", amount: 39 }, player2.token);
  ok("player B manual payment queued", m2.status === 201 && m2.data && m2.data.autoApproved === false, m2.data);

  const adminLogin = await req("POST", "/api/auth/login", { email: ADMIN.email, password: ADMIN.password });
  const t1 = await req("GET", "/api/admin/transactions?status=pending", null, adminLogin.data.token);
  ok("admin notified about manual receipt", (t1.data.notifications || []).some((n) => /إيصال جديد/.test(n.title)), t1.data.notifications);
  ok("pending FIFO (oldest first)", (() => {
    const ts = t1.data.transactions || [];
    if (ts.length < 2) return true;
    return ts.every((tx, i) => i === 0 || new Date(ts[i - 1].createdAt) <= new Date(tx.createdAt));
  })(), (t1.data.transactions || []).map((t) => t.createdAt));
  const t2 = await req("GET", "/api/admin/transactions?status=pending", null, adminLogin.data.token);
  ok("notification drained once", !(t2.data.notifications || []).length, t2.data.notifications);

  // ---------- D. Shortlist + scout notes ----------
  console.log("[D] Club shortlist + private scout notes");
  const slAdd = await req("POST", "/api/players/" + playerId + "/shortlist", { in: true }, club.token);
  ok("add to shortlist", slAdd.status === 200 && slAdd.data.shortlisted === true && slAdd.data.count === 1, slAdd.data);
  const gp = await req("GET", "/api/players/" + playerId, null, club.token);
  ok("player GET exposes shortlisted", gp.data.shortlisted === true, gp.data.shortlisted);
  const note = await req("PUT", "/api/players/" + playerId + "/scout-note", { note: "سرعة ممتازة — يحتاج تحسين التمركز" }, club.token);
  ok("scout note saved", note.status === 200 && note.data.note === "سرعة ممتازة — يحتاج تحسين التمركز", note.data);
  const gp2 = await req("GET", "/api/players/" + playerId, null, club.token);
  ok("player GET exposes myScoutNote", gp2.data.myScoutNote === "سرعة ممتازة — يحتاج تحسين التمركز", gp2.data.myScoutNote);
  const gclub = await req("GET", "/api/clubs/" + clubId, null, club.token);
  ok("club detail includes shortlist player", (gclub.data.shortlist || []).some((p) => p.id === playerId), gclub.data.shortlist);
  const noteUp = await req("PUT", "/api/players/" + playerId + "/scout-note", { note: "تحديث" }, club.token);
  ok("scout note updated", noteUp.data.note === "تحديث", noteUp.data);
  const noteClr = await req("PUT", "/api/players/" + playerId + "/scout-note", { note: "" }, club.token);
  ok("scout note cleared", noteClr.data.note === null, noteClr.data);

  // ---------- E. sort=rating ----------
  console.log("[E] Sort by rating");
  const rate = await req("POST", "/api/players/" + playerId + "/review", { stars: 5, comment: "ممتاز" }, club.token);
  ok("club rated player A (5)", rate.status === 200 && rate.data.rating === 5, rate.data);
  const sorted = await req("GET", "/api/players?sort=rating&limit=50");
  const ids = (sorted.data.players || []).map((p) => p.id);
  ok("rating sort: rated player first", ids.indexOf(playerId) !== -1 && ids.indexOf(playerId) < ids.indexOf(player2Id), ids);

  // ---------- F. Video poster thumbnail ----------
  console.log("[F] Video poster thumbnail");
  const up = await upload(MOV, "player_video", "video/quicktime", player.token);
  ok("video uploaded", up.status === 201 && up.data && up.data.files && up.data.files[0], up.data);
  const upUrl = up.data && up.data.files && up.data.files[0] && up.data.files[0].url;
  const thumbName = upUrl ? upUrl.replace(/\.(mp4|mov|mkv|3gp|3g2|m4v|webm|ogv)$/i, ".jpg") : null;
  ok("poster URL derivable from video URL", !!(thumbName && thumbName.endsWith(".jpg")), { upUrl, thumbName });
  let thumbExists = false;
  const thumbPath = thumbName ? path.join(ROOT, "uploads", path.basename(thumbName)) : null;
  for (let i = 0; i < 40; i++) {
    if (thumbPath && fs.existsSync(thumbPath)) { thumbExists = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok("thumbnail file generated", thumbExists, thumbPath);
  if (thumbExists) {
    const st = fs.statSync(thumbPath);
    ok("thumbnail is a real image (>1KB)", st.size > 1024, st.size);
  }

  console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });