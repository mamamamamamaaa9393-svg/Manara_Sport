/* Critical-fixes verification (no production code modified by this test).
   Boots the REAL route handlers in-memory and asserts the three CRITICAL
   fixes:
     1. Kashier webhook refuses when not configured (forgery closed).
     2. Applications list masks player PII + documents for the viewing club.
     3. Player profile never leaks the matched club's contact/docs to a
        non-owner viewer.
   db.json is backed up and restored so the on-disk store is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

// --- Ensure Kashier is NOT configured so we exercise the new 503 guard ----
delete process.env.KASHIER_API_KEY;
delete process.env.KASHIER_SECRET_KEY;
delete process.env.KASHIER_MERCHANT_ID;

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".critical-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const express = require("express");
const db = require("../src/db");
const { sign } = require("../src/middleware/auth");

let server, base;
const CLUB_ID = "club_user_x";

function boot() {
  const app = express();
  app.use(express.json());
  app.use("/api/applications", require("../src/routes/applications.routes"));
  app.use("/api/players", require("../src/routes/players.routes"));
  app.use("/api/payments", require("../src/routes/payment.routes"));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
}

function seed() {
  const store = db.get();
  store.players = store.players || [];
  store.clubs = store.clubs || [];
  store.applications = store.applications || [];
  const player = {
    id: "p_test", userId: null, name: "Test Player", sport: "Football",
    currentClub: "Test FC", phone: "0123456789", email: "p@x.com",
    whatsapp: "0123456788", documents: { birth: "/uploads/b.pdf" },
    declaration: "/uploads/d.pdf", approved: true
  };
  const clubOwner = {
    id: "c_test", userId: CLUB_ID, name: "Test FC", sport: "Football",
    phone: "0199999999", email: "c@x.com",
    documents: { license: "/uploads/l.pdf" }, declaration: "/uploads/dc.pdf"
  };
  const app1 = {
    id: "a_test", clubUserId: CLUB_ID, playerId: "p_test", type: "scout",
    message: "hi", status: "pending", createdAt: new Date().toISOString()
  };
  store.players.push(player);
  store.clubs.push(clubOwner);
  store.applications.push(app1);
}

function authHeader(role) {
  return "Bearer " + sign({ id: CLUB_ID, role });
}

// Require a FRESH payment router with Kashier configured or not. kashier.js
// reads its env at module-load time, so we must clear the require cache after
// setting/deleting the env vars to deterministically exercise both paths.
function freshPaymentRouter(configured) {
  if (configured) {
    process.env.KASHIER_API_KEY = "test_api_key";
    process.env.KASHIER_SECRET_KEY = "test_secret_key";
    process.env.KASHIER_MERCHANT_ID = "test_merchant";
  } else {
    delete process.env.KASHIER_API_KEY;
    delete process.env.KASHIER_SECRET_KEY;
    delete process.env.KASHIER_MERCHANT_ID;
  }
  delete require.cache[require.resolve("../src/kashier")];
  delete require.cache[require.resolve("../src/routes/payment.routes")];
  return require("../src/routes/payment.routes");
}

function buildWebhookApp(configured) {
  const app = express();
  app.use(express.json());
  app.use("/api/payments", freshPaymentRouter(configured));
  const srv = app.listen(0);
  return { srv, url: "http://127.0.0.1:" + srv.address().port };
}

async function main() {
  await db.init();
  boot();
  seed();
  let failures = 0;

  // ---- FIX 1a: Kashier webhook forgery guard (NOT configured) ----
  try {
    const { srv, url } = buildWebhookApp(false);
    const res = await fetch(url + "/api/payments/kashier/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-kashier-signature": "abc" },
      body: JSON.stringify({ data: { status: "SUCCESS", amount: "29900", merchantOrderId: "MAN-x" } })
    });
    srv.close();
    assert.strictEqual(res.status, 503, "webhook should refuse (503) when Kashier is not configured");
    console.log("PASS 1a: Kashier webhook refuses when unconfigured (forgery closed)");
  } catch (e) { failures++; console.error("FAIL 1a:", e.message); }

  // ---- FIX 1b: correctly-signed webhook (configured) is accepted past guard ----
  try {
    const crypto = require("crypto");
    const { srv, url } = buildWebhookApp(true);
    const API_KEY = "test_api_key";
    const data = {
      merchantOrderId: "MAN-nonexistent",
      amount: "29900",
      currency: "EGP",
      transactionId: "tx_1",
      status: "SUCCESS",
      signatureKeys: ["merchantOrderId", "amount", "currency", "transactionId", "status"]
    };
    const signedKeys = data.signatureKeys.slice().sort();
    const payload = signedKeys
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(data[k])))
      .join("&");
    const sig = crypto.createHmac("sha256", API_KEY).update(payload).digest("hex");
    const res = await fetch(url + "/api/payments/kashier/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-kashier-signature": sig },
      body: JSON.stringify({ event: "pay", data })
    });
    srv.close();
    // Passes the enabled guard + signature, then fails order lookup (404) — proving
    // a legitimate, correctly-signed webhook is no longer blocked by the 503 guard.
    assert.strictEqual(res.status, 404, "valid signed webhook should pass guard (404 = order not found)");
    console.log("PASS 1b: correctly-signed webhook accepted past guard (reaches order lookup)");
  } catch (e) { failures++; console.error("FAIL 1b:", e.message); }

  // ---- FIX 2: Applications list masks player PII + documents ----
  try {
    const res = await fetch(base + "/api/applications", {
      headers: { Authorization: authHeader("club") }
    });
    const body = await res.json();
    const p = body.applications && body.applications[0] && body.applications[0].player;
    assert.ok(p, "application should include a player object");
    assert.strictEqual(p.documents, undefined, "documents must NOT be exposed to the viewing club");
    assert.strictEqual(p.declaration, undefined, "declaration must NOT be exposed");
    assert.ok(p.phone && p.phone.indexOf("***") !== -1, "phone should be masked, got: " + p.phone);
    assert.ok(p.email && p.email.indexOf("***") !== -1, "email should be masked, got: " + p.email);
    console.log("PASS 2: Applications list masks player PII + documents for club viewer");
  } catch (e) { failures++; console.error("FAIL 2:", e.message); }

  // ---- FIX 3: Player profile hides matched club contact/docs ----
  try {
    const res = await fetch(base + "/api/players/p_test", {
      headers: { Authorization: authHeader("club") }
    });
    const body = await res.json();
    assert.ok(body.club, "matched currentClub should be returned");
    assert.strictEqual(body.club.phone, undefined, "club phone must NOT leak");
    assert.strictEqual(body.club.email, undefined, "club email must NOT leak");
    assert.strictEqual(body.club.documents, undefined, "club documents must NOT leak");
    assert.strictEqual(body.club.declaration, undefined, "club declaration must NOT leak");
    assert.ok(body.player.phone && body.player.phone.indexOf("***") !== -1, "player phone should be masked");
    console.log("PASS 3: Player profile hides matched club contact + documents from non-owner");
  } catch (e) { failures++; console.error("FAIL 3:", e.message); }

  server.close();
  // restore on-disk store
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  if (failures) { console.error("\n" + failures + " test(s) FAILED"); process.exit(1); }
  console.log("\nALL CRITICAL FIXES VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
