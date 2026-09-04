/* AI Assistant Smart Matching integration test.
   Ensures the chat assistant can recommend players/clubs from a natural
   message, and replies "عذراً، الوصف غير موجود" when the requested criteria
   produce no matches. Also confirms non-recommendation questions fall through
   to the normal flow, and that replies never leak private contact data.

   NOTE: the chat endpoint is gated by requireActiveSub (by design). These
   tests use TRIALING users so they legitimately pass the paywall — they verify
   the integration WORKS inside the gated assistant, not that it bypasses it.
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".aimatch-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const { detectIntent, extractCriteria, runMatch } = require("../src/ai/matchTool");
const app = require("../src/app");

let server, base;
const auth = (role, id) => "Bearer " + sign({ id, role });
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

async function main() {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  store.players = store.players || [];
  store.clubs = store.clubs || [];

  // A trialing club user + a trialing player user (they pass the paywall gate).
  const clubU = "u_ai_club", playerU = "u_ai_player";
  store.users.push({ id: clubU, role: "club", approved: true, name: "ClubAI", subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 7 * 86400000) });
  store.users.push({ id: playerU, role: "player", approved: true, name: "PlayerAI", subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 2 * 86400000) });

  // Clubs.
  const cfb = "u_c_ai1", cbb = "u_c_ai2";
  store.users.push({ id: cfb, role: "club", approved: true, name: "Cairo FC", subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 7 * 86400000) });
  store.users.push({ id: cbb, role: "club", approved: true, name: "Hoops Club", subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 7 * 86400000) });
  store.clubs.push({ id: "c_ai_fb", userId: cfb, name: "Cairo FC", sport: "Football", neededPosition: "Striker", country: "Egypt", city: "Cairo", keywords: "football striker egypt", approved: true });
  store.clubs.push({ id: "c_ai_bb", userId: cbb, name: "Hoops Club", sport: "Basketball", neededPosition: "Guard", country: "Egypt", keywords: "basketball guard", approved: true });

  // Players.
  const pfw = "u_p_ai1", ppf = "u_p_ai2";
  store.users.push({ id: pfw, role: "player", approved: true, name: "P1", subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 2 * 86400000) });
  store.users.push({ id: ppf, role: "player", approved: true, name: "P2", subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 2 * 86400000) });
  store.players.push({ id: "p_ai_fw", userId: pfw, name: "Ali Gaber", position: "Striker (ST)", sport: "Football", country: "Egypt", level: "Pro", available: true, phone: "01012345678", email: "ali@x.com", documents: { birth_cert: "/x.jpg" }, keywords: "striker football egypt pace", approved: true });
  store.players.push({ id: "p_ai_pf", userId: ppf, name: "Mark", position: "Power Forward", sport: "Basketball", country: "Egypt", level: "Pro", available: true, phone: "0112222", email: "mark@x.com", documents: { birth_cert: "/y.jpg" }, keywords: "power forward basketball rebound", approved: true });
  db.save();

  // ---- UNIT: intent + criteria detection ----
  let d = detectIntent("رشّح لي مهاجم من مصر");
  assert.ok(d && d.kind === "player", "recommend player intent");
  assert.strictEqual(d.criteria.position, "striker", "position striker");
  assert.strictEqual(d.criteria.country, "Egypt", "country Egypt");
  console.log("PASS U1: detects 'رشّح لي مهاجم من مصر' as a player recommendation (striker / Egypt)");

  d = detectIntent("عرّفني على الاشتراكات");
  assert.strictEqual(d, null, "non-recommendation => null");
  console.log("PASS U2: non-recommendation question is not treated as a match request");

  let r = runMatch("رشّح لي لاعبين لكرة السلة");
  assert.ok(r.recognized && r.found, "basketball players found");
  assert.ok(r.items.some((i) => i.kind === "player" && i.sport === "Basketball"), "basketball player present");
  console.log("PASS U3: runMatch finds basketball players");

  // Criteria with no results => found=false
  r = runMatch("رشّح لي حارس مرمى من السويد");
  assert.ok(r.recognized, "recognized");
  assert.strictEqual(r.found, false, "no goalkeeper from Sweden => not found");
  console.log("PASS U4: unmatched criteria => found=false");

  // ---- SERVER: chat endpoint integration ----
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const chat = async (token, message) => {
    const resp = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    return resp;
  };

  // 1) Player recommendation via chat -> recognizes and returns a match
  let resp = await chat(auth("club", clubU), "رشّح لي مهاجم من مصر");
  assert.strictEqual(resp.status, 200, "chat 200");
  let body = await resp.json();
  assert.strictEqual(body.provider, "matchTool", "provider=matchTool");
  assert.ok(/لاعبون مقترحون/.test(body.reply), "reply mentions suggested players");
  assert.ok(/Ali Gaber/.test(body.reply), "reply names the matching player");
  assert.ok(!/01112345678|ali@x\.com/.test(body.reply), "no private contact leaked in reply");
  assert.ok(!/birth_cert/.test(body.reply), "no documents leaked in reply");
  console.log("PASS S1: chat returns a matched player recommendation without leaking contact data");

  // 2) Unknown criteria -> "الوصف غير موجود"
  resp = await chat(auth("club", clubU), "رشّح لي حارس مرمى من السويد");
  body = await resp.json();
  assert.strictEqual(body.provider, "matchTool", "provider=matchTool");
  assert.ok(/الوصف غير موجود/.test(body.reply), "not-found message returned");
  console.log("PASS S2: chat returns 'الوصف غير موجود' when criteria have no matches");

  // 3) A non-recommendation question still works (normal flow) and is NOT
  //    short-circuited as "not found".
  resp = await chat(auth("club", clubU), "ما هي فترة التجربة المجانية للأندية؟");
  body = await resp.json();
  assert.strictEqual(resp.status, 200, "chat 200 for normal question");
  assert.notStrictEqual(body.provider, "matchTool", "not routed to matchTool");
  assert.ok(body.reply && body.reply.length > 0, "normal reply present");
  console.log("PASS S3: a normal question is not mistaken for a match request (falls through)");

  // 4) Club recommendations for a player via chat.
  resp = await chat(auth("player", playerU), "رشّح لي نادي كرة قدم");
  body = await resp.json();
  assert.strictEqual(body.provider, "matchTool", "provider=matchTool");
  assert.ok(/أندية مقترحة/.test(body.reply), "reply mentions suggested clubs");
  assert.ok(/Cairo FC/.test(body.reply), "reply names a matching club");
  assert.ok(!/011|@/.test(body.reply), "no club contact leaked");
  console.log("PASS S4: chat returns club recommendations for a player (no contact leaked)");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  console.log("\nAI ASSISTANT SMART MATCHING VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
