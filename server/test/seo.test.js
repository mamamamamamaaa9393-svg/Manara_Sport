/* Verify the crawlable profile pages + dynamic sitemap fix the critical SEO
   gap (player/club profiles were JS-rendered and invisible to crawlers).
   - GET /player/<slug> renders full HTML with meta + canonical + JSON-LD,
     and NEVER leaks private contact data (email/phone).
   - GET /club/<slug> renders full HTML with JSON-LD.
   - Unknown / unapproved profiles -> 404 (no soft-404).
   - GET /sitemap.xml is dynamic XML containing every approved profile URL
     plus the public static pages, and excludes unapproved profiles.
   db.json is backed up and restored; the running server is untouched. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const BACKUP = DB_FILE + ".seo-test-backup";
fs.copyFileSync(DB_FILE, BACKUP);

const db = require("../src/db");
const app = require("../src/app");

let server, base;
const P_SLUG = "seo-player", C_SLUG = "seo-club", HIDDEN = "hidden-player";

async function main() {
  await db.init();
  const store = db.get();
  store.users = store.users || [];
  store.players = store.players || [];
  store.clubs = store.clubs || [];

  if (!store.users.find((u) => u.id === "u_seo_p")) store.users.push({ id: "u_seo_p", role: "player", name: "SeoP", approved: true });
  if (!store.users.find((u) => u.id === "u_seo_c")) store.users.push({ id: "u_seo_c", role: "club", name: "SeoC", approved: true });
  if (!store.users.find((u) => u.id === "u_seo_hidden")) store.users.push({ id: "u_seo_hidden", role: "player", name: "Hidden", approved: false });

  if (!store.players.find((p) => p.id === "p_seo")) {
    store.players.push({
      id: "p_seo", userId: "u_seo_p", slug: P_SLUG, name: "سيف تيست",
      sport: "Football", position: "مهاجم", country: "مصر", level: "محترف",
      email: "secret@x.com", phone: "0123456789", bio: "مهاجم شاب موهوب.",
      approvedAccount: true
    });
  }
  if (!store.players.find((p) => p.id === "p_hidden")) {
    store.players.push({
      id: "p_hidden", userId: "u_seo_hidden", slug: HIDDEN, name: "مخفي",
      sport: "Football", email: "hide@x.com", approvedAccount: true
    });
  }
  if (!store.clubs.find((c) => c.id === "c_seo")) {
    store.clubs.push({
      id: "c_seo", userId: "u_seo_c", slug: C_SLUG, name: "نادي تيست",
      sport: "Football", type: "نادي محترف", country: "مصر", approvedAccount: true
    });
  }
  db.save();

  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // ---- Player SSR ----
  let r = await fetch(base + "/player/" + P_SLUG);
  assert.strictEqual(r.status, 200, "approved player profile must be 200");
  let html = await r.text();
  assert.ok(html.includes("سيف تيست"), "player name must be in HTML");
  assert.ok(html.includes('rel="canonical"') && html.includes("/player/" + P_SLUG), "canonical must point to /player/<slug>");
  assert.ok(html.includes("application/ld+json") && html.includes('"@type":"Person"'), "must include Person JSON-LD");
  assert.ok(!html.includes("secret@x.com"), "email must NOT leak in public profile");
  assert.ok(!html.includes("0123456789"), "phone must NOT leak in public profile");
  console.log("PASS 1: approved player profile is crawlable + privacy-safe (200, name, canonical, JSON-LD, no PII)");

  // ---- Unapproved / unknown player -> 404 (no soft-404) ----
  r = await fetch(base + "/player/" + HIDDEN);
  assert.strictEqual(r.status, 404, "unapproved player must be 404");
  r = await fetch(base + "/player/does-not-exist");
  assert.strictEqual(r.status, 404, "unknown player must be 404");
  console.log("PASS 2: unapproved/unknown player returns 404 (no soft-404)");

  // ---- Club SSR ----
  r = await fetch(base + "/club/" + C_SLUG);
  assert.strictEqual(r.status, 200, "approved club profile must be 200");
  html = await r.text();
  assert.ok(html.includes("نادي تيست"), "club name must be in HTML");
  assert.ok(html.includes("application/ld+json") && html.includes('"@type":"SportsOrganization"'), "must include SportsOrganization JSON-LD");
  console.log("PASS 3: approved club profile is crawlable + JSON-LD (200)");

  // ---- Sitemap ----
  r = await fetch(base + "/sitemap.xml");
  assert.strictEqual(r.status, 200, "sitemap must be 200");
  const xml = await r.text();
  assert.ok(xml.includes("<urlset"), "sitemap must be valid xml");
  assert.ok(xml.includes("/player/" + P_SLUG), "sitemap must include approved player URL");
  assert.ok(xml.includes("/club/" + C_SLUG), "sitemap must include approved club URL");
  assert.ok(xml.includes("/jobs.html"), "sitemap must include static jobs page");
  assert.ok(!xml.includes("/player/" + HIDDEN), "sitemap must EXCLUDE unapproved player");
  console.log("PASS 4: dynamic sitemap lists approved profiles + static pages, excludes unapproved");

  server.close();
  fs.copyFileSync(BACKUP, DB_FILE);
  fs.unlinkSync(BACKUP);
  console.log("\nSEO PROFILE INDEXING VERIFIED OK");
}

main().catch((e) => {
  try { fs.copyFileSync(BACKUP, DB_FILE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error("TEST ERROR:", e);
  process.exit(1);
});
