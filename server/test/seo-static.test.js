/* Static-page SEO hardening (the 🟡 items) — regression guard:
   - every static .html has dir="rtl"
   - public pages carry a self-referencing canonical <link>
   - profile/club app pages do NOT have a static canonical (their JS sets it,
     so we must not create a duplicate canonical)
   - index.html + about.html carry Organization JSON-LD
   - index.html hero alt is sports-relevant (not the old office photo alt)
   - robots.txt Sitemap directive points at the production sitemap (no conflict) */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..", "..", "roster");
const SKIP_CANONICAL = new Set([
  "profile.html", "club-profile.html", "messages.html", "shortlist.html",
  "admin.html", "admin-declarations.html", "inquiry-track.html", "404.html"
]);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name); }
}

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
for (const f of files) {
  const s = fs.readFileSync(path.join(ROOT, f), "utf8");
  ok(f + " has dir=\"rtl\"", /dir="rtl"/i.test(s));
  if (SKIP_CANONICAL.has(f)) {
    ok(f + " has NO static canonical (JS owns it)", !/rel="canonical"/i.test(s));
  } else {
    ok(f + " has canonical link", /rel="canonical"/i.test(s));
  }
}

const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const about = fs.readFileSync(path.join(ROOT, "about.html"), "utf8");
ok("index.html has Organization JSON-LD", /id="manara-org-jsonld"/.test(index) && /"@type":"Organization"/.test(index));
ok("about.html has Organization JSON-LD", /id="manara-org-jsonld"/.test(about) && /"@type":"Organization"/.test(about));
ok("index.html hero alt is sports-relevant", /alt="لاعب كرة قدم شاب/.test(index));
ok("index.html no longer has old office hero alt", !/Smiling professional working on a laptop/.test(index));

const robots = fs.readFileSync(path.join(ROOT, "robots.txt"), "utf8");
ok("robots.txt Sitemap points to production sitemap", /Sitemap:\s*https:\/\/manara\.app\/sitemap\.xml/i.test(robots));

console.log("\n=== STATIC SEO: " + pass + " passed, " + fail + " failed ===");
process.exit(fail ? 1 : 0);
