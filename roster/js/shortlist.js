(function () {
  "use strict";

  if (!window.API || !window.API.token()) {
    window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
    return;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function sportAr(s) {
    return { "Football": "كرة القدم", "Basketball": "كرة السلة", "Tennis": "التنس", "Volleyball": "الكرة الطائرة", "Handball": "كرة اليد", "Golf": "الجولف", "Karate": "الكاراتيه", "Swimming": "السباحة", "Multi-sport": "متعدد الرياضات" }[s] || s;
  }

  function starRow(n) {
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= Math.round(n) ? "★" : "☆";
    return s;
  }

  function playerAge(p) {
    if (p && p.age != null) return p.age + " سنة";
    var dob = p && (p.dob || p.birthDate);
    if (!dob) return "—";
    var b = new Date(dob);
    if (isNaN(b)) return "—";
    var diff = new Date() - b;
    return Math.floor(diff / (365.25 * 24 * 3600 * 1000)) + " سنة";
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.style.background = isError ? "var(--rose,#e11d48)" : "var(--green,#16a34a)";
    el.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = "0"; }, 3800);
  }

  var players = [];

  function render() {
    var box = document.getElementById("shortlistBox");
    var compare = document.getElementById("compareBtn");
    var compareBar = document.getElementById("compareBar");
    var compareBox = document.getElementById("compareBox");
    if (!box) return;
    if (!players.length) {
      box.innerHTML = '<div class="short-empty">⭐ لا يوجد لاعبون في القائمة المختصرة بعد — افتح ملف لاعب من صفحة اللاعبين واضغط «قائمة مختصرة».</div>';
      if (compare) compare.style.display = "none";
      if (compareBar) compareBar.style.display = "none";
      if (compareBox) compareBox.style.display = "none";
      return;
    }
    if (compare) compare.style.display = "inline-block";
    if (compareBar) compareBar.style.display = "flex";
    box.innerHTML = players.map(function (p) {
      var stars = p.rating > 0
        ? '<span class="stars">' + starRow(p.rating) + "</span>"
        : '<span style="font-size:11px;color:var(--gray-400);font-weight:600;">لا تقييم بعد</span>';
      return '<div class="short-row" data-id="' + esc(p.id) + '">' +
        '<div class="short-ava">' + esc((p.name || "P").charAt(0).toUpperCase()) + "</div>" +
        '<div class="short-info"><b>' + esc(p.name || "لاعب") + "</b>" +
        '<span class="sub">' + esc(p.position || "—") + (p.sport ? " · " + esc(sportAr(p.sport)) : "") + "</span>" +
        "<span>" + stars + "</span></div>" +
        '<div class="short-actions">' +
        '<a class="short-view" href="/player/' + esc(p.slug || p.id) + '">عرض</a>' +
        '<a class="short-msg" href="messages.html?player=' + esc(p.slug || p.id) + '">💬 مراسلة</a>' +
        '<button class="short-remove" type="button" data-remove="' + esc(p.id) + '">إزالة</button>' +
        "</div></div>";
    }).join("");
  }

  function compare() {
    var box = document.getElementById("compareBox");
    if (!box) return;
    var rows = [
      ["الاسم", function (p) { return p.name || "—"; }],
      ["الرياضة", function (p) { return sportAr(p.sport) || "—"; }],
      ["المركز", function (p) { return p.position || "—"; }],
      ["المستوى", function (p) { return p.level || "—"; }],
      ["العمر", function (p) { return playerAge(p); }],
      ["الطول", function (p) { return p.height ? p.height + " cm" : "—"; }],
      ["الوزن", function (p) { return p.weight ? p.weight + " kg" : "—"; }],
      ["القدم", function (p) { return p.foot || "—"; }],
      ["التقييم", function (p) { return p.rating > 0 ? p.rating.toFixed(1) + " ★" : "—"; }],
      ["التوفر", function (p) { return p.available === false ? "مرتبط بعقد" : "متاح"; }],
      ["البلد", function (p) { return p.country || "—"; }]
    ];
    var head = '<tr><th>المعيار</th>' +
      players.map(function (p) { return "<th>" + esc(p.name || "لاعب") + "</th>"; }).join("") + "</tr>";
    var body = rows.map(function (r) {
      return "<tr><td>" + r[0] + "</td>" +
        players.map(function (p) {
          var v = r[1](p);
          return "<td>" + esc(v) + "</td>";
        }).join("") + "</tr>";
    }).join("");
    box.innerHTML = "<table>" + head + body + "</table>";
    box.style.display = "block";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function initAuthNav() {
    var nameEl = document.getElementById("authUserName");
    var logoutBtn = document.getElementById("logoutBtn");
    if (!window.API || !window.API.token()) return;
    window.API.getMe().then(function (res) {
      var user = res && res.user;
      if (nameEl && user && user.name) nameEl.textContent = "👤 " + user.name;
      var sl = document.getElementById("navShortlist");
      if (sl) sl.style.display = (user && user.role === "club") ? "" : "none";
    }).catch(function () {});
    if (logoutBtn) logoutBtn.addEventListener("click", function () {
      window.API.logout();
      window.location.href = "Sign/Sign_In.html";
    });
  }

  function init() {
    initAuthNav();

    var trial = document.getElementById("trialBanner");
    window.API.getMe().then(function (me) {
      if (!me || !me.user) {
        window.API.logout();
        window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      var role = me.user.role;
      if (role === "admin") {
        window.location.href = "admin.html";
        return;
      }
      var own = me.profile;
      if (!own || own.id.indexOf("c_") !== 0) {
        if (own && own.id.indexOf("p_") === 0) window.location.href = "profile.html?player=" + encodeURIComponent(own.slug || own.id);
        else window.location.href = "club-profile.html";
        return;
      }
      // Subscription state comes from the status endpoint. SubBanner verifies
      // the REAL paid/pending status before showing any "subscribe now" prompt
      // (a paid user whose trialEnd is still in the future must NOT see it).
      window.API.subscriptionStatus().then(function (st) {
        if (window.SubBanner) window.SubBanner.render(trial, st);
      }).catch(function () {});
      // Load the club with its shortlist.
      window.API.getClub(own.id).then(function (res) {
        players = ((res && res.shortlist) || []).filter(function (p) { return p && p.id; });
        render();
      }).catch(function (err) {
        if (err && err.status === 403) {
          toast("لا يمكنك عرض هذه القائمة", true);
        } else {
          toast("تعذر تحميل القائمة المختصرة", true);
        }
        var box = document.getElementById("shortlistBox");
        if (box) box.innerHTML = '<div class="short-empty">تعذر تحميل القائمة المختصرة.</div>';
      });
    }).catch(function (err) {
      if (err && err.status === 401) {
        window.API.logout();
        window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
      }
    });

    var box = document.getElementById("shortlistBox");
    if (box) box.addEventListener("click", function (e) {
      var rm = e.target.closest("[data-remove]");
      if (rm) {
        var id = rm.getAttribute("data-remove");
        window.API.shortlistPlayer(id, false).then(function () {
          players = players.filter(function (p) { return p.id !== id; });
          render();
          toast("تمت الإزالة من القائمة المختصرة");
        }).catch(function () { toast("تعذرت الإزالة", true); });
      }
    });

    var run = document.getElementById("compareRun");
    if (run) run.addEventListener("click", compare);
    var cb = document.getElementById("compareBtn");
    if (cb) cb.addEventListener("click", compare);
  }

  init();
})();