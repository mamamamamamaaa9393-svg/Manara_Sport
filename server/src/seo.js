/* Server-rendered, crawlable profile pages + dynamic sitemap.
   The public front-end renders player/club profiles client-side from the
   API, so search-engine crawlers (and users without JS) never see the most
   valuable content. These routes return fully-rendered, privacy-safe HTML
   (public copy only — no phone/email/whatsapp/instagram/documents/declaration)
   with proper meta tags, a canonical URL and JSON-LD structured data, so each
   approved profile is individually indexable. */

const db = require("./db");

const SITE_URL = (process.env.SITE_URL || "https://manara.app").replace(/\/$/, "");

function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attr(v) { return esc(v); }

function text(v, fallback) {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s || (fallback || "");
}

// Build a short, keyword-rich meta description from the public fields.
function playerDescription(p) {
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.position) parts.push("— " + p.position);
  if (p.sport) parts.push(p.sport);
  if (p.level) parts.push(p.level);
  if (p.country) parts.push(p.country);
  let d = parts.join(" ") + " على منصة منارة لاكتشاف المواهب الرياضية.";
  if (p.bio) d += " " + p.bio.slice(0, 160);
  return d.slice(0, 300).trim();
}

function clubDescription(c) {
  const parts = [];
  if (c.name) parts.push(c.name);
  if (c.type) parts.push(c.type);
  if (c.sport) parts.push(c.sport);
  if (c.country) parts.push(c.country);
  let d = parts.join(" ") + " على منصة منارة — نادي موثّق يكتشف ويتعاقد مع اللاعبين.";
  if (c.description) d += " " + c.description.slice(0, 160);
  return d.slice(0, 300).trim();
}

function playerRow(label, value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  return '<div class="pf-row"><span class="pf-k">' + esc(label) + '</span><span class="pf-v">' + esc(value) + "</span></div>";
}

function playerProfileHtml(p) {
  const pub = db.publicPlayer(p) || p;
  const slug = pub.slug || pub.id;
  const canonical = SITE_URL + "/player/" + encodeURIComponent(slug);
  const photo = text(pub.photo, SITE_URL + "/img/logo.png");
  const name = text(pub.name, "لاعب");
  const title = name + (pub.position ? " — " + pub.position : "") + " | منارة";
  const desc = playerDescription(pub);
  const city = text(pub.country);
  const clubName = text(pub.currentClub);

  const rows =
    playerRow("الرياضة", pub.sport) +
    playerRow("المركز", pub.position) +
    playerRow("القدم", pub.foot) +
    playerRow("العمر", pub.age) +
    playerRow("الطول", pub.height ? pub.height + " سم" : "") +
    playerRow("الوزن", pub.weight ? pub.weight + " كجم" : "") +
    playerRow("المستوى", pub.level) +
    playerRow("الجنسية / الدولة", pub.country) +
    playerRow("النادي الحالي", pub.currentClub) +
    playerRow("متاح للانتقال", pub.available ? "نعم" : "") +
    playerRow("الكلمات المفتاحية", Array.isArray(pub.keywords) ? pub.keywords.join("، ") : (pub.keywords || ""));

  const stats = text(pub.stats);
  const bio = text(pub.bio);
  const videos = Array.isArray(pub.videos) ? pub.videos.filter(Boolean) : [];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": name,
    "url": canonical,
    "description": desc,
    "image": photo
  };
  if (pub.position) jsonLd.jobTitle = pub.position;
  if (pub.sport) jsonLd.sport = pub.sport;
  if (city) jsonLd.address = { "@type": "PostalAddress", "addressCountry": city };
  if (clubName) jsonLd.memberOf = { "@type": "SportsOrganization", "name": clubName };

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(desc)}">
<link rel="canonical" href="${attr(canonical)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${attr(canonical)}">
<meta property="og:image" content="${attr(photo)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/vendor/bootstrap.min.css">
<link rel="stylesheet" href="/css/style.css">
<style>
.pf-wrap{max-width:820px;margin:32px auto;padding:0 16px}
.pf-card{background:var(--surface,#fff);border:1px solid var(--line,#e5e7eb);border-radius:18px;padding:24px;box-shadow:0 10px 30px rgba(2,6,23,.06)}
.pf-head{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.pf-photo{width:120px;height:120px;border-radius:16px;object-fit:cover;border:1px solid var(--line,#e5e7eb)}
.pf-name{font-size:28px;font-weight:900;margin:0}
.pf-sub{color:var(--muted,#64748b);margin:4px 0 0}
.pf-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-top:18px}
.pf-row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed var(--line,#e5e7eb);padding:8px 0}
.pf-k{color:var(--muted,#64748b)}
.pf-v{font-weight:700}
.pf-bio{margin-top:18px;white-space:pre-wrap;line-height:1.8}
.pf-cta{margin-top:22px;text-align:center}
.btn-pill{border-radius:999px}
</style>
</head>
<body>
<main class="pf-wrap">
  <article class="pf-card">
    <div class="pf-head">
      <img class="pf-photo" src="${attr(photo)}" alt="${attr(name + (pub.position ? " — " + pub.position : ""))}">
      <div>
        <h1 class="pf-name">${esc(name)}</h1>
        <p class="pf-sub">${esc([pub.sport, pub.position, pub.level].filter(Boolean).join(" · "))}</p>
      </div>
    </div>
    <div class="pf-grid">${rows}</div>
    ${bio ? '<div class="pf-bio">' + esc(bio) + "</div>" : ""}
    ${stats ? '<div class="pf-bio"><strong>الإحصائيات:</strong><br>' + esc(stats) + "</div>" : ""}
    ${videos.length ? '<div class="pf-bio"><strong>فيديوهات:</strong> ' + videos.length + " فيديو ظاهر في ملف اللاعب</div>" : ""}
    <div class="pf-cta">
      <a class="btn btn-primary btn-pill" href="/profile.html?player=${attr(slug)}">عرض الملف الكامل والتواصل</a>
    </div>
  </article>
</main>
</body>
</html>`;
}

function clubProfileHtml(c) {
  const pub = db.publicClub(c) || c;
  const slug = pub.slug || pub.id;
  const canonical = SITE_URL + "/club/" + encodeURIComponent(slug);
  const logo = text(pub.logo, SITE_URL + "/img/logo.png");
  const name = text(pub.name, "نادي");
  const title = name + (pub.sport ? " — " + pub.sport : "") + " | منارة";
  const desc = clubDescription(pub);

  const rows =
    playerRow("النوع", pub.type) +
    playerRow("الرياضة", pub.sport) +
    playerRow("الدولة", pub.country) +
    playerRow("المدينة", pub.city) +
    playerRow("تأسس في", pub.founded) +
    playerRow("الدوري", pub.league);

  const about = text(pub.description);
  const achievements = text(pub.achievements);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SportsOrganization",
    "name": name,
    "url": canonical,
    "description": desc,
    "image": logo
  };
  if (pub.sport) jsonLd.sport = pub.sport;
  if (pub.country) jsonLd.address = { "@type": "PostalAddress", "addressCountry": pub.country };

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(desc)}">
<link rel="canonical" href="${attr(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${attr(canonical)}">
<meta property="og:image" content="${attr(logo)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/vendor/bootstrap.min.css">
<link rel="stylesheet" href="/css/style.css">
<style>
.pf-wrap{max-width:820px;margin:32px auto;padding:0 16px}
.pf-card{background:var(--surface,#fff);border:1px solid var(--line,#e5e7eb);border-radius:18px;padding:24px;box-shadow:0 10px 30px rgba(2,6,23,.06)}
.pf-head{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.pf-photo{width:120px;height:120px;border-radius:16px;object-fit:cover;border:1px solid var(--line,#e5e7eb)}
.pf-name{font-size:28px;font-weight:900;margin:0}
.pf-sub{color:var(--muted,#64748b);margin:4px 0 0}
.pf-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-top:18px}
.pf-row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed var(--line,#e5e7eb);padding:8px 0}
.pf-k{color:var(--muted,#64748b)}
.pf-v{font-weight:700}
.pf-bio{margin-top:18px;white-space:pre-wrap;line-height:1.8}
.pf-cta{margin-top:22px;text-align:center}
</style>
</head>
<body>
<main class="pf-wrap">
  <article class="pf-card">
    <div class="pf-head">
      <img class="pf-photo" src="${attr(logo)}" alt="${attr(name)}">
      <div>
        <h1 class="pf-name">${esc(name)}</h1>
        <p class="pf-sub">${esc([pub.type, pub.sport, pub.country].filter(Boolean).join(" · "))}</p>
      </div>
    </div>
    <div class="pf-grid">${rows}</div>
    ${about ? '<div class="pf-bio">' + esc(about) + "</div>" : ""}
    ${achievements ? '<div class="pf-bio"><strong>الإنجازات:</strong><br>' + esc(achievements) + "</div>" : ""}
    <div class="pf-cta">
      <a class="btn btn-primary btn-pill" href="/club-profile.html">عرض ملف النادي والتواصل</a>
    </div>
  </article>
</main>
</body>
</html>`;
}

function notFoundHtml() {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>404 — الصفحة غير موجودة | منارة</title>
<meta name="robots" content="noindex"></head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
<h1>404</h1><p>الصفحة غير موجودة.</p>
<a href="/">العودة للرئيسية</a></body></html>`;
}

function buildSitemap() {
  const store = db.get();
  const urls = [];

  const add = (loc, changefreq, priority) =>
    urls.push("  <url><loc>" + esc(loc) + "</loc><changefreq>" + changefreq + "</changefreq><priority>" + priority + "</priority></url>");

  // Static public pages
  add(SITE_URL + "/", "weekly", "1.0");
  add(SITE_URL + "/jobs.html", "daily", "0.9");
  add(SITE_URL + "/clubs.html", "daily", "0.8");
  add(SITE_URL + "/about.html", "monthly", "0.6");
  add(SITE_URL + "/contact.html", "monthly", "0.5");
  add(SITE_URL + "/plans.html", "monthly", "0.6");
  add(SITE_URL + "/subscribe.html", "monthly", "0.6");
  add(SITE_URL + "/how-to-pay.html", "monthly", "0.5");
  add(SITE_URL + "/privacy.html", "yearly", "0.3");
  add(SITE_URL + "/terms.html", "yearly", "0.3");
  add(SITE_URL + "/ai-assistant.html", "monthly", "0.5");

  // Dynamic, approved player profiles
  (store.players || [])
    .filter((p) => db.profileApproved(p))
    .forEach((p) => {
      const slug = p.slug || p.id;
      add(SITE_URL + "/player/" + encodeURIComponent(slug), "weekly", "0.8");
    });

  // Dynamic, approved club profiles
  (store.clubs || [])
    .filter((c) => db.profileApproved(c))
    .forEach((c) => {
      const slug = c.slug || c.id;
      add(SITE_URL + "/club/" + encodeURIComponent(slug), "weekly", "0.7");
    });

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("\n") + "\n</urlset>\n";
}

module.exports = {
  SITE_URL,
  playerProfileHtml,
  clubProfileHtml,
  notFoundHtml,
  buildSitemap
};
