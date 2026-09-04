/* Feature verification: an authenticated CLUB may view a player's MEDICAL
   REPORT (documents.medical) in the player profile, but no other proof
   document (birth certificate / declaration), and no other viewer role may
   see it. db.json + uploads/ are backed up / cleaned so nothing persists. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".medical-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const MED_FILE = path.join(UPLOAD_DIR, "test_medical.pdf");
const BIRTH_FILE = path.join(UPLOAD_DIR, "test_birth.pdf");
fs.writeFileSync(MED_FILE, "%PDF-1.4 test medical");
fs.writeFileSync(BIRTH_FILE, "%PDF-1.4 test birth");

const express = require("express"); // ensure deps present
const db = require("../src/db");
const { sign } = require("../src/middleware/auth");
const app = require("../src/app");

const CLUB_ID = "club_medical_x";
let server, base, failures = 0;

function auth(role, id) { return "Bearer " + sign({ id: id || role + "_x", role }); }

async function main() {
  await db.init();
  const store = db.get();
  store.players = store.players || [];
  const player = {
    id: "p_med", userId: null, name: "Medical Test Player", sport: "Football",
    currentClub: "X", approved: true,
    documents: { medical: "/uploads/test_medical.pdf", birth_cert: "/uploads/test_birth.pdf" }
  };
  store.players.push(player);

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // 1) Club profile response includes medical, excludes birth_cert
  try {
    const res = await fetch(base + "/api/players/p_med", { headers: { Authorization: auth("club", CLUB_ID) } });
    const body = await res.json();
    assert.ok(body.player.documents && body.player.documents.medical, "club should receive medical URL");
    assert.strictEqual(body.player.documents.birth_cert, undefined, "club must NOT receive birth_cert");
    assert.strictEqual(body.player.documents.declaration, undefined, "club must NOT receive declaration");
    console.log("PASS 1: club profile exposes medical report only");
  } catch (e) { failures++; console.error("FAIL 1:", e.message); }

  // 2) Club can actually fetch the medical file
  try {
    const res = await fetch(base + "/uploads/test_medical.pdf", { headers: { Authorization: auth("club", CLUB_ID) } });
    assert.strictEqual(res.status, 200, "club should be able to open the medical report");
    console.log("PASS 2: club can open medical report file (200)");
  } catch (e) { failures++; console.error("FAIL 2:", e.message); }

  // 3) Club CANNOT fetch the birth certificate
  try {
    const res = await fetch(base + "/uploads/test_birth.pdf", { headers: { Authorization: auth("club", CLUB_ID) } });
    assert.strictEqual(res.status, 403, "club must be blocked from birth certificate");
    console.log("PASS 3: club blocked from birth certificate (403)");
  } catch (e) { failures++; console.error("FAIL 3:", e.message); }

  // 4) A non-club viewer (player) is blocked from the medical report
  try {
    const res = await fetch(base + "/uploads/test_medical.pdf", { headers: { Authorization: auth("player", "other_p") } });
    assert.strictEqual(res.status, 403, "non-club viewer must be blocked from medical report");
    console.log("PASS 4: non-club viewer blocked from medical report (403)");
  } catch (e) { failures++; console.error("FAIL 4:", e.message); }

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP);
  fs.unlinkSync(MED_FILE); fs.unlinkSync(BIRTH_FILE);
  if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
  console.log("\nMEDICAL REPORT CLUB ACCESS VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  try { fs.unlinkSync(MED_FILE); fs.unlinkSync(BIRTH_FILE); } catch (_) {}
  console.error("TEST ERROR:", e); process.exit(1);
});
