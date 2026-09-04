/* ==========================================================================
   Manara — club board (clubs.html)
   Loads verified clubs from /api/clubs and renders a filterable grid.
   Players can browse clubs but never message them — only clubs may start a
   conversation (enforced server-side too).
   ========================================================================== */
(function () {
  "use strict";

  var allClubs = [];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function sportAr(s) {
    var map = {
      football: "كرة القدم", basketball: "كرة السلة", tennis: "التنس",
      volleyball: "الكرة الطائرة", handball: "كرة اليد", golf: "الجولف",
      karate: "الكاراتيه", swimming: "السباحة"
    };
    return map[String(s || "").toLowerCase()] || s || "—";
  }

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
  }

  function chipClass(idx) {
    return ["lc-blue", "lc-teal", "lc-violet", "lc-amber", "lc-rose", "lc-green", "lc-ink"][idx % 7];
  }

  function renderCard(c, i) {
    var name = c.name || "Club";
    var meta = [];
    if (c.type) meta.push(c.type);
    if (c.sport) meta.push(sportAr(c.sport));
    if (c.country) meta.push(c.country);
    var tags = [];
    if (c.city) tags.push("📍 " + esc(c.city));
    if (c.league) tags.push("🏆 " + esc(c.league));
    if (c.founded) tags.push("📅 " + esc(c.founded));
    var need = c.neededPosition
      ? '<div class="job-need">🔍 يبحث حالياً عن: <b>' + esc(c.neededPosition) + "</b></div>"
      : "";
    var desc = c.description ? '<p class="job-desc">' + esc(c.description) + "</p>" : "";

    return '<article class="job reveal in" data-keywords="' + esc((name + " " + (c.city || "") + " " + (c.league || "") + " " + (c.country || "") + " " + (c.sport || "") + " " + (c.type || "") + " " + (c.neededPosition || "") + " " + (c.keywords || "")).toLowerCase()) + '" data-sport="' + esc((c.sport || "").toLowerCase()) + '" data-type="' + esc((c.type || "").toLowerCase()) + '" data-ctry="' + esc((c.country || "").toLowerCase()) + '">' +
      '<span class="logo-chip ' + chipClass(i) + '" aria-hidden="true">' + esc(initials(name)) + "</span>" +
      '<div class="job-main">' +
        '<h3 class="job-title">' + esc(name) + (c.verified !== false ? '<span class="verified-chip" title="معتمد"><span class="vc-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>معتمد</span>' : "") + "</h3>" +
        '<p class="job-company"><b>' + esc(meta.join(" · ")) + "</b></p>" +
        desc +
        need +
        '<div class="job-meta">' + tags.map(function (t) { return "<span>" + t + "</span>"; }).join("") + "</div>" +
      "</div>" +
      '<div class="job-side"><a class="btn btn-outline-ink btn-pill" href="/club/' + esc(c.slug || c.id) + '">View</a></div>' +
    "</article>";
  }

  function initFilters() {
    var list = document.getElementById("clubList");
    if (!list) return;
    var countEl = document.getElementById("resultCount");
    var totalEl = document.getElementById("totalCount");
    var noRes = document.getElementById("noResults");

    var kw = document.getElementById("fKeyword");
    var catChecks = Array.prototype.slice.call(document.querySelectorAll(".f-cat"));
    var typeChecks = Array.prototype.slice.call(document.querySelectorAll(".f-type"));
    var ctryIn = document.getElementById("fCountry");
    var sortBy = document.getElementById("sortBy");

    var apply = function () {
      var qRaw = (kw && kw.value || "").trim();
      var q = qRaw.toLowerCase();
      var cats = catChecks.filter(function (c) { return c.checked; }).map(function (c) { return c.value.toLowerCase(); });
      var types = typeChecks.filter(function (c) { return c.checked; }).map(function (c) { return c.value.toLowerCase(); });
      var ctryQ = (ctryIn && ctryIn.value || "").trim().toLowerCase();
      var qTokens = (window.SearchUtil && qRaw) ? window.SearchUtil.expand(qRaw) : null;
      var visible = 0;

      Array.prototype.forEach.call(list.querySelectorAll(".job"), function (job) {
        var ok = true;
        if (q) {
          var keys = job.getAttribute("data-keywords") || "";
          if (qTokens) {
            if (!window.SearchUtil.match([keys, job.getAttribute("data-sport") || ""].join(" "), qTokens)) ok = false;
          } else if (keys.indexOf(q) === -1) ok = false;
        }
        if (ok && cats.length) { var sc = job.getAttribute("data-sport") || ""; if (cats.indexOf(sc) === -1) ok = false; }
        if (ok && types.length) { var ty = job.getAttribute("data-type") || ""; if (types.indexOf(ty) === -1) ok = false; }
        if (ok && ctryQ) { var cc = job.getAttribute("data-ctry") || ""; if (cc.indexOf(ctryQ) === -1) ok = false; }
        job.classList.toggle("is-hidden", !ok);
        if (ok) visible++;
      });

      if (countEl) countEl.textContent = visible;
      if (totalEl) totalEl.textContent = allClubs.length;
      if (noRes) noRes.classList.toggle("show", visible === 0);
    };

    if (!initFilters.wired) {
      initFilters.wired = true;
      if (kw) kw.addEventListener("input", apply);
      catChecks.forEach(function (c) { c.addEventListener("change", apply); });
      typeChecks.forEach(function (c) { c.addEventListener("change", apply); });
      if (ctryIn) ctryIn.addEventListener("input", apply);
      if (sortBy) sortBy.addEventListener("change", apply);

      var clearBtn = document.getElementById("clearFilters");
      if (clearBtn) clearBtn.addEventListener("click", function () {
        if (kw) kw.value = "";
        catChecks.forEach(function (c) { c.checked = false; });
        typeChecks.forEach(function (c) { c.checked = false; });
        if (ctryIn) ctryIn.value = "";
        apply();
      });

      // Mobile collapsible filters (same pattern as the players board)
      var toggle = document.getElementById("filtersToggle");
      var panel = document.getElementById("filtersPanel");
      if (toggle && panel) {
        toggle.addEventListener("click", function () {
          var open = panel.classList.toggle("is-collapsed");
          toggle.setAttribute("aria-expanded", open ? "false" : "true");
        });
      }
    }

    apply();
  }

  // Auto-refresh every 30s so newly approved clubs appear for every account
  // without a manual page reload.
  function load() {
    var list = document.getElementById("clubList");
    if (!list || !window.API) return;
    window.API.getClubs(new URLSearchParams({ limit: "50" }))
      .then(function (res) {
        var clubs = res && (res.clubs || res.data);
        if (clubs && clubs.length) {
          allClubs = clubs;
          list.innerHTML = clubs.map(renderCard).join("");
          initFilters();
        }
      })
      .catch(function () {});
  }

  function init() {
    load();
    setInterval(load, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();