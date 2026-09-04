/* ==========================================================================
   Roster — vanilla JavaScript. No jQuery, no plugins.
   One function per feature. Guard clauses. IntersectionObserver.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --------------------------------------------------- Sticky + mobile nav */
  function initNav() {
    var nav = document.getElementById("siteNav");
    var toggle = document.getElementById("navToggle");
    var links = document.getElementById("navLinks");
    if (!nav) return;

    var onScroll = function () {
      nav.classList.toggle("is-stuck", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    if (!toggle || !links) return;
    var setOpen = function (open) {
      nav.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("nav-open"));
    });
    links.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
  }

  /* --------------------------------------------------- Scroll reveal */
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    if (reduceMotion || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (el) { io.observe(el); });
  }

  /* --------------------------------------------------- Count-up stats */
  function loadStats() {
    if (!window.API) return Promise.resolve();
    return window.API.getStats()
      .then(function (s) {
        var map = {
          players: s.players,
          clubs: s.clubs,
          sports: s.sports,
          countries: s.countries,
          pro: (s.byType && s.byType["نادي محترف"]) || 0,
          academy: (s.byType && s.byType["أكاديمية"]) || 0,
          amateur: (s.byType && s.byType["نادي هاوٍ"]) || 0,
          center: (s.byType && s.byType["مركز تدريب"]) || 0,
          team: (s.byType && s.byType["منتخب"]) || 0
        };
        document.querySelectorAll("[data-stat]").forEach(function (el) {
          var k = el.getAttribute("data-stat");
          if (map[k] != null) el.setAttribute("data-count", String(map[k]));
        });
        document.querySelectorAll("[data-sport-count]").forEach(function (b) {
          var sport = b.getAttribute("data-sport-count");
          b.textContent = String((s.bySport && s.bySport[sport]) || 0);
        });
      })
      .catch(function () {});
  }

  function initCountUp() {
    var nums = document.querySelectorAll("[data-count]");
    if (!nums.length) return;

    var format = function (n, suffix) {
      return n.toLocaleString("en-US") + (suffix || "");
    };
    var run = function (el) {
      var target = parseInt(el.getAttribute("data-count"), 10) || 0;
      var suffix = el.getAttribute("data-suffix") || "";
      if (reduceMotion) { el.textContent = format(target, suffix); return; }
      var dur = 1400, start = null;
      var step = function (ts) {
        if (start === null) start = ts;
        var p = Math.min((ts - start) / dur, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = format(Math.round(target * eased), suffix);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (!("IntersectionObserver" in window)) {
      nums.forEach(function (el) { run(el); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { run(entry.target); io.unobserve(entry.target); }
      });
    }, { threshold: 0.5 });
    nums.forEach(function (el) { io.observe(el); });
  }

  /* --------------------------------------------------- How-it-works tabs */
  function initFlowTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".flow-tab"));
    if (!tabs.length) return;

    var select = function (tab) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.setAttribute("tabindex", selected ? "0" : "-1");
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) {
          panel.classList.toggle("is-hidden", !selected);
          if (selected) { panel.removeAttribute("hidden"); }
          else { panel.setAttribute("hidden", ""); }
        }
      });
    };

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab); });
      tab.addEventListener("keydown", function (e) {
        var idx = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") idx = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") idx = (i - 1 + tabs.length) % tabs.length;
        if (idx !== null) { e.preventDefault(); tabs[idx].focus(); select(tabs[idx]); }
      });
    });

    // Sync initial state (JS on): hide the inactive panel via the hidden attribute.
    var current = tabs.filter(function (t) { return t.getAttribute("aria-selected") === "true"; })[0] || tabs[0];
    select(current);
  }

  /* --------------------------------------------------- Newsletter / alerts */
  function initAlertForm() {
    var form = document.getElementById("alertForm");
    if (!form) return;
    var input = document.getElementById("alertEmail");
    var msg = document.getElementById("alertMsg");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!input.value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value)) {
        input.focus();
        input.setAttribute("aria-invalid", "true");
        return;
      }
      input.removeAttribute("aria-invalid");
      if (msg) msg.classList.add("show");
      form.reset();
    });
    if (input) input.addEventListener("input", function () {
      input.removeAttribute("aria-invalid");
      if (msg) msg.classList.remove("show");
    });
  }

  /* --------------------------------------------------- Job filtering (both pages) */
  function initJobFilter() {
    var list = document.getElementById("jobList");
    if (!list) return;
    var jobs = [];
    var refreshJobs = function () {
      jobs = Array.prototype.slice.call(list.querySelectorAll(".job"));
    };
    refreshJobs();

    var kw = document.getElementById("fKeyword");
    var catSelect = document.getElementById("fCategory");
    var typeSelect = document.getElementById("fType");
    var catChecks = Array.prototype.slice.call(document.querySelectorAll(".f-cat"));
    var typeChecks = Array.prototype.slice.call(document.querySelectorAll(".f-type"));
    var remote = document.getElementById("fRemote");
    var sortBy = document.getElementById("sortBy");
    var countEl = document.getElementById("resultCount");
    var noRes = document.getElementById("noResults");
    var loadMore = document.getElementById("loadMore");
    var posIn = document.getElementById("fPosition");
    var lvlSel = document.getElementById("fLevel");
    var ageMin = document.getElementById("fAgeMin");
    var ageMax = document.getElementById("fAgeMax");
    var hgtMin = document.getElementById("fHeightMin");
    var hgtMax = document.getElementById("fHeightMax");
    var ctryIn = document.getElementById("fCountry");
    var expanded = false;

    var activeCats = function () {
      if (catChecks.length) return catChecks.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      if (catSelect && catSelect.value) return [catSelect.value];
      return [];
    };
    var activeTypes = function () {
      if (typeChecks.length) return typeChecks.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      if (typeSelect && typeSelect.value) return [typeSelect.value];
      return [];
    };

    var anyFilter = function () {
      return (kw && kw.value.trim()) || activeCats().length || activeTypes().length ||
        (remote && remote.checked) || (posIn && posIn.value.trim()) || (lvlSel && lvlSel.value) ||
        (ageMin && ageMin.value) || (ageMax && ageMax.value) ||
        (hgtMin && hgtMin.value) || (hgtMax && hgtMax.value) || (ctryIn && ctryIn.value.trim());
    };

    var apply = function () {
      var q = kw ? kw.value.trim().toLowerCase() : "";
      var cats = activeCats();
      var types = activeTypes();
      var remoteOnly = remote ? remote.checked : false;
      var posQ = posIn ? posIn.value.trim() : "";
      var posNorm = window.SearchUtil && posQ ? window.SearchUtil.norm(posQ) : posQ.toLowerCase();
      var lvlQ = lvlSel ? lvlSel.value.trim() : "";
      var lvlNorm = window.SearchUtil ? window.SearchUtil.norm(lvlQ) : lvlQ.toLowerCase();
      var ctryQ = ctryIn ? ctryIn.value.trim().toLowerCase() : "";
      var ageMinV = ageMin ? parseInt(ageMin.value, 10) : NaN;
      var ageMaxV = ageMax ? parseInt(ageMax.value, 10) : NaN;
      var hgtMinV = hgtMin ? parseInt(hgtMin.value, 10) : NaN;
      var hgtMaxV = hgtMax ? parseInt(hgtMax.value, 10) : NaN;
      var visible = 0;
      var qTokens = (window.SearchUtil && q) ? window.SearchUtil.expand(kw.value) : null;

      jobs.forEach(function (job) {
        var keys = job.getAttribute("data-keywords") || "";
        var jc = job.getAttribute("data-category");
        var jt = job.getAttribute("data-type");
        var ok = true;
        if (q) {
          // Token-based AND matching with Arabic normalization + synonyms
          // when SearchUtil is available; plain substring otherwise.
          if (qTokens) {
            if (!window.SearchUtil.match([keys, jc, jt].join(" "), qTokens)) ok = false;
          } else if (keys.indexOf(q) === -1 && String(jc || "").toLowerCase().indexOf(q) === -1) {
            ok = false;
          }
        }
        if (cats.length && cats.indexOf(jc) === -1) ok = false;
        if (types.length && types.indexOf(jt) === -1) ok = false;
        if (remoteOnly && jt !== "remote") ok = false;
        if (ok && posNorm) { if ((window.SearchUtil ? window.SearchUtil.norm(job.getAttribute("data-pos") || "") : (job.getAttribute("data-pos") || "").toLowerCase()).indexOf(posNorm) === -1) ok = false; }
        if (ok && lvlNorm) { if ((window.SearchUtil ? window.SearchUtil.norm(job.getAttribute("data-lvl") || "") : (job.getAttribute("data-lvl") || "").toLowerCase()) !== lvlNorm) ok = false; }
        if (ok && ctryQ) {
          var cc = window.SearchUtil ? window.SearchUtil.norm(job.getAttribute("data-ctry") || "") : (job.getAttribute("data-ctry") || "").toLowerCase();
          if (cc.indexOf(window.SearchUtil ? window.SearchUtil.norm(ctryQ) : ctryQ) === -1) ok = false;
        }
        if (ok && !isNaN(ageMinV)) { var ja = parseInt(job.getAttribute("data-age"), 10); if (isNaN(ja) || ja < ageMinV) ok = false; }
        if (ok && !isNaN(ageMaxV)) { var ja2 = parseInt(job.getAttribute("data-age"), 10); if (isNaN(ja2) || ja2 > ageMaxV) ok = false; }
        if (ok && !isNaN(hgtMinV)) { var jh = parseInt(job.getAttribute("data-height"), 10); if (isNaN(jh) || jh < hgtMinV) ok = false; }
        if (ok && !isNaN(hgtMaxV)) { var jh2 = parseInt(job.getAttribute("data-height"), 10); if (isNaN(jh2) || jh2 > hgtMaxV) ok = false; }
        job.classList.toggle("is-hidden", !ok);
        if (ok) visible++;
      });

      // On the index page, "Load more" collapses extra cards until expanded
      // or until a filter is active (so filtered matches are never hidden).
      if (list.classList.contains("is-collapsed") || loadMore) {
        if (anyFilter() || expanded) {
          list.classList.remove("is-collapsed");
          if (loadMore) loadMore.style.display = "none";
        } else {
          list.classList.add("is-collapsed");
          if (loadMore) loadMore.style.display = "";
        }
      }

      if (countEl) countEl.textContent = visible;
      var totalEl = document.getElementById("totalCount");
      if (totalEl) totalEl.textContent = jobs.length;
      if (noRes) noRes.classList.toggle("show", visible === 0);
    };

    var sort = function () {
      if (!sortBy) return;
      if (sortBy.value === "rating") {
        jobs.sort(function (a, b) {
          var r = (parseFloat(b.getAttribute("data-rating") || "0")) - (parseFloat(a.getAttribute("data-rating") || "0"));
          if (r !== 0) return r;
          return parseInt(a.getAttribute("data-posted") || "0", 10) - parseInt(b.getAttribute("data-posted") || "0", 10);
        });
      } else {
        jobs.sort(function (a, b) {
          return parseInt(a.getAttribute("data-posted") || "0", 10) - parseInt(b.getAttribute("data-posted") || "0", 10);
        });
      }
      jobs.forEach(function (job) { list.appendChild(job); });
    };

    // wire controls
    if (kw) kw.addEventListener("input", apply);
    if (catSelect) catSelect.addEventListener("change", apply);
    if (typeSelect) typeSelect.addEventListener("change", apply);
    catChecks.forEach(function (c) { c.addEventListener("change", apply); });
    typeChecks.forEach(function (c) { c.addEventListener("change", apply); });
    if (remote) remote.addEventListener("change", apply);
    if (posIn) posIn.addEventListener("input", apply);
    if (lvlSel) lvlSel.addEventListener("change", apply);
    [ageMin, ageMax, hgtMin, hgtMax].forEach(function (n) { if (n) n.addEventListener("input", apply); });
    if (ctryIn) ctryIn.addEventListener("input", apply);
    if (sortBy) sortBy.addEventListener("change", function () { sort(); apply(); });

    // Prevent implicit form submission (Enter in the keyword field) from reloading.
    var filterForm = document.getElementById("filterBar");
    if (filterForm) filterForm.addEventListener("submit", function (e) { e.preventDefault(); });

    if (loadMore) loadMore.addEventListener("click", function () {
      expanded = true;
      list.classList.remove("is-collapsed");
      loadMore.style.display = "none";
    });

    // Clear all (sidebar)
    var clearBtn = document.getElementById("clearFilters");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      if (kw) kw.value = "";
      catChecks.forEach(function (c) { c.checked = false; });
      typeChecks.forEach(function (c) { c.checked = false; });
      if (remote) remote.checked = false;
      if (posIn) posIn.value = "";
      if (lvlSel) lvlSel.value = "";
      if (ageMin) ageMin.value = "";
      if (ageMax) ageMax.value = "";
      if (hgtMin) hgtMin.value = "";
      if (hgtMax) hgtMax.value = "";
      if (ctryIn) ctryIn.value = "";
      apply();
    });

    // Pre-fill from URL (?cat= / ?type= / ?q=) when arriving from category cards
    var params = new URLSearchParams(window.location.search);
    var pCat = params.get("cat");
    var pType = params.get("type");
    var pQ = params.get("q");
    if (pQ && kw) kw.value = pQ;
    if (pCat) {
      if (catSelect) catSelect.value = pCat;
      catChecks.forEach(function (c) { if (c.value === pCat) c.checked = true; });
    }
    if (pType) {
      if (typeSelect) typeSelect.value = pType;
      typeChecks.forEach(function (c) { if (c.value === pType) c.checked = true; });
      if (pType === "remote" && remote) remote.checked = true;
    }

    // expose for hero search / chips on the index page
    window.__rosterFilter = { apply: apply, kw: kw, catSelect: catSelect, typeSelect: typeSelect, refreshJobs: refreshJobs, sort: sort };

    apply();
  }

  /* --------------------------------------------------- Hero search + chips (index) */
  function initHeroSearch() {
    var form = document.getElementById("heroSearch");
    var goToJobs = function (keyword, category) {
      var f = window.__rosterFilter;
      if (f && document.getElementById("jobList")) {
        if (keyword != null && f.kw) f.kw.value = keyword;
        if (category != null && f.catSelect) f.catSelect.value = category;
        f.apply();
        var target = document.getElementById("jobs");
        if (target) target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
      } else {
        var qs = [];
        if (keyword) qs.push("q=" + encodeURIComponent(keyword));
        if (category) qs.push("cat=" + encodeURIComponent(category));
        window.location.href = "jobs.html" + (qs.length ? "?" + qs.join("&") : "");
      }
    };

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var data = new FormData(form);
        goToJobs((data.get("keyword") || "").toString(), (data.get("category") || "").toString());
      });
    }

    var chips = document.querySelectorAll(".search-chips .chip");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var text = chip.textContent.trim();
        var typeMap = { "Remote": "remote", "Full-time": "full-time", "Contract": "contract" };
        if (typeMap[text]) {
          var f = window.__rosterFilter;
          if (f && f.typeSelect) f.typeSelect.value = typeMap[text];
          goToJobs("", "");
        } else {
          goToJobs(text, "");
        }
      });
    });
  }

  /* --------------------------------------------------- Category cards -> board */
  function initCategoryCards() {
    var cards = document.querySelectorAll(".cat-card[href]");
    cards.forEach(function (card) {
      card.addEventListener("click", function (e) {
        var cat = card.getAttribute("data-cat");
        var type = card.getAttribute("data-type");
        if (!cat && !type) return;
        e.preventDefault();
        var qs = cat ? "cat=" + encodeURIComponent(cat) : "type=" + encodeURIComponent(type);
        window.location.href = "jobs.html?" + qs;
      });
    });
  }

  /* --------------------------------------------------- Mobile filters toggle (board) */
  function initFiltersToggle() {
    var btn = document.getElementById("filtersToggle");
    var panel = document.getElementById("filtersPanel");
    if (!btn || !panel) return;
    btn.addEventListener("click", function () {
      var open = panel.classList.toggle("is-collapsed") === false;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* --------------------------------------------------- Player cards (API mode) */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[<>&"']/g, function (c) {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ageFromDob(dob) {
    if (!dob) return null;
    var d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var age = now.getFullYear() - d.getFullYear();
    if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
    return Math.max(0, age);
  }

  function starRow(n) {
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= Math.round(n) ? "★" : "☆";
    return s;
  }

  function sportAr(s) {
    var map = {
      football: "كرة القدم", basketball: "كرة السلة", tennis: "التنس",
      volleyball: "الكرة الطائرة", handball: "كرة اليد", golf: "الجولف",
      karate: "الكاراتيه", swimming: "السباحة"
    };
    return map[String(s || "").toLowerCase()] || s || "—";
  }

  function initialsOf(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
  }

  function renderClubCard(c) {
    var name = esc(c.name || "Club");
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
    return '<article class="job reveal in" data-kind="club" data-category="' + esc(c.sport) + '" data-type="' + esc((c.type || "").toLowerCase()) + '" data-posted="0" data-rating="0" data-keywords="' + esc((name + " " + (c.city || "") + " " + (c.league || "") + " " + (c.country || "") + " " + (c.sport || "") + " " + (c.type || "") + " " + (c.neededPosition || "") + " " + (c.keywords || "")).toLowerCase()) + '" data-ctry="' + esc((c.country || "").toLowerCase()) + '">' +
      '<span class="logo-chip lc-teal" aria-hidden="true">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="' + name + '" loading="lazy">' : esc(initialsOf(c.name))) + '</span>' +
      '<div class="job-main">' +
        '<h3 class="job-title"><a href="/club/' + esc(c.slug || c.id) + '">' + name + '</a></h3>' +
        '<p class="job-company"><b>' + esc(meta.join(" · ")) + "</b></p>" +
        desc + need +
        '<div class="job-meta">' + tags.map(function (t) { return "<span>" + t + "</span>"; }).join("") + "</div>" +
      "</div>" +
      '<div class="job-side"><a class="btn btn-outline-ink btn-pill" href="/club/' + encodeURIComponent(c.slug || c.id) + '">View</a></div>' +
    "</article>";
  }

  /* --------------------------------------------------- Board state (players + clubs) */
  var boardState = { mode: "all", players: [], clubs: [] };

  function updateCategoryCounts() {
    var counts = {};
    boardState.players.forEach(function (p) { var s = p.sport || "Other"; counts[s] = (counts[s] || 0) + 1; });
    boardState.clubs.forEach(function (c) { var s = c.sport || "Other"; counts[s] = (counts[s] || 0) + 1; });
    document.querySelectorAll(".f-cat").forEach(function (cb) {
      var span = cb.parentElement.querySelector(".cnt");
      if (span) span.textContent = String(counts[cb.value] || 0);
    });
  }

  function updateCountUnit() {
    var el = document.getElementById("countUnit");
    if (!el) return;
    el.textContent = boardState.mode === "clubs" ? "أندية" : (boardState.mode === "players" ? "لاعب" : "نتيجة");
  }

  function renderBoard() {
    var list = document.getElementById("jobList");
    if (!list) return;
    var cards = [];
    if (boardState.mode !== "clubs") cards = cards.concat(boardState.players.map(renderPlayerCard));
    if (boardState.mode !== "players") cards = cards.concat(boardState.clubs.map(renderClubCard));
    list.innerHTML = cards.join("");
    updateCategoryCounts();
    updateCountUnit();
    var f = window.__rosterFilter;
    if (f && f.refreshJobs) { f.refreshJobs(); if (f.sort) f.sort(); f.apply(); }
  }

  /* --------------------------------------------------- Load players from API */
  function initApiPlayers() {
    return new Promise(function (resolve) {
      var list = document.getElementById("jobList");
      if (!list || !window.API) { resolve(); return; }
      var params = new URLSearchParams(window.location.search);
      var qs = new URLSearchParams();
      if (params.get("cat")) qs.set("sport", params.get("cat"));
      if (params.get("q")) qs.set("keyword", params.get("q"));
      qs.set("limit", "50");

      var load = function () {
        return window.API.getPlayers(qs)
          .then(function (res) {
            boardState.players = (res && (res.players || res.data)) || [];
            renderBoard();
          })
          .catch(function () {});
      };

      load().then(function () {
        resolve();
        // Auto-refresh every 30s so newly approved players appear for every
        // account without a manual page reload.
        setInterval(load, 30000);
      });
    });
  }

  /* --------------------------------------------------- Load clubs from API */
  function initApiClubs() {
    var list = document.getElementById("jobList");
    if (!list || !window.API) return;
    var load = function () {
      return window.API.getClubs(new URLSearchParams({ limit: "50" }))
        .then(function (res) {
          boardState.clubs = (res && (res.clubs || res.data)) || [];
          renderBoard();
        })
        .catch(function () {});
    };
    load();
    // Auto-refresh every 30s so newly approved clubs appear too.
    setInterval(load, 30000);
  }

  /* --------------------------------------------------- Unified search tabs */
  function initSearchTabs() {
    var tabs = document.querySelectorAll("#searchTabs .search-tab");
    if (!tabs.length) { boardState.mode = "players"; return; }
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        boardState.mode = tab.dataset.mode;
        tabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
        renderBoard();
      });
    });
  }

  function renderPlayerCard(p) {
    var name = esc(p.name);
    var club = esc(p.currentClub || p.club || "");
    var sport = esc(p.sport || "");
    var position = esc(p.position || "");
    var country = esc(p.country || "");
    var level = esc(p.level || "");
    var initials = name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    var available = p.available !== false;
    var age = p.age != null ? p.age : ageFromDob(p.dob);
    var tags = [age ? age + " yrs" : null, p.height ? p.height + "cm" : null, level].filter(Boolean);
    var verified = p.verified !== false ? '<span class="verified-chip" title="معتمد"><span class="vc-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>معتمد</span>' : "";
    var rating = Number(p.rating) || 0;
    var ratingStar = rating > 0
      ? '<span class="rating-row" title="' + rating.toFixed(1) + ' من 5"><span style="color:#fbbf24;letter-spacing:1px;">' + starRow(rating) + "</span><span style=\"font-size:11px;color:var(--gray-500);font-weight:700;margin-inline-start:4px;\">" + rating.toFixed(1) + (p.reviews ? " · " + p.reviews + " تقييم" : "") + "</span></span>"
      : "";
    var companyParts = [];
    if (club) companyParts.push("<b>" + club + "</b>");
    if (position) companyParts.push(position);
    if (sport) companyParts.push(sport);
    return '<article class="job reveal in" data-category="' + esc(p.sport) + '" data-type="' + (available ? "available" : "contract") + '" data-posted="' + (p.postedDays || 0) + '" data-rating="' + rating + '" data-keywords="' + esc((p.keywords || name + " " + position + " " + club + " " + sport + " " + country).toLowerCase()) + '" data-pos="' + esc(position.toLowerCase()) + '" data-lvl="' + esc(level.toLowerCase()) + '" data-ctry="' + esc(country.toLowerCase()) + '" data-age="' + (age != null ? age : "") + '" data-height="' + (p.height != null ? p.height : "") + '">' +
      '<span class="logo-chip lc-blue" aria-hidden="true">' + (p.photo ? '<img src="' + esc(p.photo) + '" alt="' + esc(name) + '" loading="lazy">' : esc(initials)) + '</span>' +
      '<div class="job-main">' +
        '<h3 class="job-title"><a href="/player/' + esc(p.slug || p.id) + '">' + name + '</a>' + verified + '</h3>' +
        '<p class="job-company">' + (companyParts.length ? companyParts.join(" · ") : "&mdash;") + '</p>' +
        (ratingStar ? '<div class="job-meta">' + ratingStar + "</div>" : "") +
        '<div class="job-meta"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>' + country + '</span></div>' +
        '<div class="job-tags">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join("") + '</div>' +
      '</div>' +
      '<div class="job-side"><a class="btn btn-outline-ink btn-pill" href="/player/' + encodeURIComponent(p.slug || p.id) + '" data-player-card="' + esc(p.id) + '">View</a></div>' +
    '</article>';
  }

  /* --------------------------------------------------- Auth nav (user + logout) */
  function initAuthNav() {
    var cta = document.querySelector(".nav-cta");
    var link = document.getElementById("navProfile");
    var heroBtn = document.getElementById("heroProfileBtn");
    if (!cta && !link && !heroBtn) return;

    var setHref = function (id, isClub, isAdmin) {
      var href = isAdmin
        ? "admin.html"
        : isClub
          ? "club-profile.html"
          : "profile.html" + (id ? "?player=" + encodeURIComponent(id) : "");
      if (link) link.href = href;
      if (heroBtn) heroBtn.href = href;
    };

    var setShortlist = function (show) {
      var sl = document.getElementById("navShortlist");
      if (sl) sl.style.display = show ? "" : "none";
    };

    if (!window.API || !window.API.token()) { setHref(null, false, false); setShortlist(false); return; }

    window.API.getMe()
      .then(function (res) {
        var user = res && res.user;
        var profile = res && res.profile;
        var isClub = !!(profile && profile.id && profile.id.indexOf("c_") === 0);
        var isAdmin = !!(user && user.role === "admin");
        if (cta) {
          cta.innerHTML =
            (user ? '<span class="signin" style="cursor:default">👤 ' + esc(user.name) + '</span>' : "") +
            '<button class="btn btn-outline-ink btn-pill" id="logoutBtn" type="button">Logout</button>';
          var lb = document.getElementById("logoutBtn");
          if (lb) lb.addEventListener("click", function () {
            window.API.logout();
            window.location.href = "Sign/Sign_In.html";
          });
        }
        setShortlist(isClub);
        setHref(profile && (profile.slug || profile.id) ? (profile.slug || profile.id) : null, isClub, isAdmin);
      })
      .catch(function () { setHref(null); setShortlist(false); });
  }

  /* --------------------------------------------------- Boot */
  function init() {
    initNav();
    initReveal();
    initFlowTabs();
    initAlertForm();
    initAuthNav();
    loadStats().then(function () { initCountUp(); });
    initSearchTabs();
    initApiPlayers().then(function () {
      initJobFilter();
      initHeroSearch();
      initCategoryCards();
      initFiltersToggle();
      initApiClubs();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
