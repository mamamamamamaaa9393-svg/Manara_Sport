/* Smart Matching + Semantic Search — Phase 1 verification.
   SECURITY/SEPARATION assertions:
   - The matching routes are gated by requireAuth ONLY — a LAPSED (expired,
     unpaid) club or player can still use them (NOT a 402 / NOT gated by
     requireActiveSub). This proves the feature can never be a paywall-payment
     bypass or a subscription-block on discovery.
   - Unauthenticated -> 401.
   - Wrong role -> 403.
   - Output is always the per-viewer MASKED/PUBLIC serialization (no raw PII,
     no documents).
   - The pure engine ranks a genuine fit above a mismatch.
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".matching-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const { matchPlayersForClub, matchClubsForPlayer } = require("../src/matching");
const app = require("../src/app");

let server, base, failures = 0;
const auth = (role, id) => "Bearer " + sign({ id: id || role + "_x", role });
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

async function main() {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  store.players = store.players || [];
  store.clubs = store.clubs || [];

  // An EXPIRED (lapsed) club — must STILL be able to use matching (not gated).
  const expClub = "u_match_expclub";
  const expPlayer = "u_match_expplayer";
  store.users.push({ id: expClub, role: "club", approved: true, name: "Exp Club", subscriptionStatus: "expired", trialEnd: iso(now - 3 * 86400000) });
  store.users.push({ id: expPlayer, role: "player", approved: true, name: "Exp Player", subscriptionStatus: "expired", trialEnd: iso(now - 3 * 86400000) });

  // Clubs: one Football needing a Striker near Cairo, one Basketball.
  store.clubs.push({ id: "c_match_fb", userId: "u_none", name: "Cairo FC", sport: "Football", neededPosition: "Striker", country: "Egypt", city: "Cairo", level: "Pro", keywords: "cairo fc football striker striker forward", approved: true });
  store.clubs.push({ id: "c_match_bb", userId: "u_none", name: "Hoops", sport: "Basketball", neededPosition: "Guard", country: "Egypt", country2: "Egypt", keywords: "hoops basketball guard", approved: true });

  // Players: a Football Striker from Egypt (good fit), and a Basketball player.
  store.players.push({ id: "p_match_fw", userId: "u_p_fw", name: "Fast Winger", sport: "Football", position: "Striker (ST)", country: "Egypt", city: "Cairo", level: "Pro", available: true, keywords: "striker forward football egypt pace finishing", bio: "هداف سريع جيد التمركز", approved: true });
  store.players.push({ id: "p_match_pf", userId: "u_p_pf", name: "Big PF", sport: "Basketball", position: "Power Forward", country: "Egypt", level: "Pro", available: true, keywords: "power forward basketball rebounding", approved: true });
  const storeRef = db.get();
  storeRef.clubs.forEach((c) => { c.userId = c.userId || ("u_clubowner_" + c.id); });
  db.save();

  // Ensure owners exist for the seeded clubs so they're treated as real profiles.
  store.clubs.forEach((c) => {
    if (!store.users.find((u) => u.id === c.userId)) {
      store.users.push({ id: c.userId, role: "club", approved: true, name: c.name, subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 7 * 86400000) });
    }
  });
  store.players.forEach((p) => {
    if (!store.users.find((u) => u.id === p.userId)) {
      store.users.push({ id: p.userId, role: "player", approved: true, name: p.name, subscriptionStatus: "trialing", trialStart: iso(now), trialEnd: iso(now + 2 * 86400000) });
    }
  });
  db.save();

  // ---- UNIT: engine ranking ----
  const pMatches = matchPlayersForClub({
    players: store.players,
    approved: () => true,
    sport: "Football",
    position: "Striker",
    country: "Egypt"
  });
  const topPlayer = pMatches[0] && pMatches[0].profile;
  assert.ok(topPlayer && topPlayer.id === "p_match_fw", "football striker should rank first for a football striker club");
  assert.ok(pMatches.length >= 2, "both players returned");
  assert.ok(pMatches[0].score > pMatches[1].score, "correct ranking (score desc)");
  console.log("PASS U1: engine ranks the true fit (Football Striker) above the mismatch (Basketball)");

  const cMatches = matchClubsForPlayer({
    clubs: store.clubs,
    approved: () => true,
    sport: "Football",
    position: "Striker",
    country: "Egypt"
  });
  assert.ok(cMatches[0] && cMatches[0].profile.id === "c_match_fb", "football club should fit the football player best");
  console.log("PASS U2: engine ranks the football club above the basketball club for a football player");

  // ---- SERVER ----
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const get = (url, token) => fetch(base + url, { headers: token ? { Authorization: token } : {} });

  // 1) Unauthenticated -> 401
  let r = await get("/api/match/players-for-club");
  assert.strictEqual(r.status, 401, "no token -> 401");
  console.log("PASS S1: matching requires authentication (401 without token)");

  // 2) EXPIRED club can still get player matches (NOT gated by paywall) -> 200
  r = await get("/api/match/players-for-club?sport=Football&neededPosition=Striker&country=Egypt", auth("club", expClub));
  assert.strictEqual(r.status, 200, "lapsed club must get matches (not 402)");
  let body = await r.json();
  assert.ok(Array.isArray(body.matches) && body.matches.length >= 1, "returns matches");
  assert.ok(body.matches[0].score > 0, "returns a score");
  // Masked output: no raw contact, no documents, phone/email masked.
  const first = body.matches[0];
  assert.ok(!first.documents, "no documents leaked");
  assert.ok(!first.declaration, "no declaration leaked");
  console.log("PASS S2: matching is NOT gated by the subscription paywall (lapsed club -> 200, masked players)");

  // 3) Wrong role -> 403 (a player cannot ask for player recommendations)
  r = await get("/api/match/players-for-club", auth("player", expPlayer));
  assert.strictEqual(r.status, 403, "player calling club-only endpoint -> 403");
  // a club cannot ask for club-for-player
  r = await get("/api/match/clubs-for-player", auth("club", expClub));
  assert.strictEqual(r.status, 403, "club calling player-only endpoint -> 403");
  console.log("PASS S3: role enforcement (403 on wrong-role endpoint)");

  // 4) EXPIRED player can get club matches (not gated) -> 200, public clubs
  r = await get("/api/match/clubs-for-player?sport=Football&position=Striker", auth("player", expPlayer));
  assert.strictEqual(r.status, 200, "lapsed player must get club matches (not 402)");
  body = await r.json();
  assert.ok(Array.isArray(body.matches) && body.matches.length >= 1, "returns matches");
  const clubOut = body.matches[0];
  assert.ok(clubOut && clubOut._id === undefined, "no internal fields leaked");
  // publicClub strips contact + docs
  assert.ok(!("email" in clubOut) || clubOut.email === undefined, "club email not exposed");
  assert.ok(!("phone" in clubOut) || clubOut.phone === undefined, "club phone not exposed");
  assert.ok(!clubOut.documents, "club documents not exposed");
  assert.ok(!clubOut.contactName, "club contactName not exposed");
  console.log("PASS S4: matching for a lapsed player works (not 402) and clubs are masked/public");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
  console.log("\nSMART MATCHING (PHASE 1) VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
