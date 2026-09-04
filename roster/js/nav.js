/* Shared mobile hamburger menu for the .nav pages (profile / club / messages / admin / subscribe).
   The index & jobs pages already wire their own nav toggle inside main.js initNav(). */
(function () {
  "use strict";
  function initMsgBadge() {
    if (!window.API || !window.API.token()) return;
    var badges = Array.prototype.slice.call(document.querySelectorAll(".msg-badge"));
    if (!badges.length) return;

    var render = function (count) {
      badges.forEach(function (b) {
        if (!count) { b.hidden = true; return; }
        b.hidden = false;
        b.textContent = count > 99 ? "99+" : String(count);
      });
    };

    var refresh = function () {
      window.API.getUnreadCount()
        .then(function (res) { render((res && res.count) || 0); })
        .catch(function () {});
    };

    refresh();
    setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
    window.__msgBadgeRefresh = refresh;
  }

  function initNav() {
    var toggle = document.getElementById("navToggle");
    if (!toggle) return;
    var nav = toggle.closest("nav");
    if (!nav) return;

    var setOpen = function (open) {
      nav.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };

    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("nav-open"));
    });

    var links = nav.querySelector(".nav-links");
    if (links) {
      links.addEventListener("click", function (e) {
        if (e.target.closest("a")) setOpen(false);
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });

    document.addEventListener("click", function (e) {
      if (nav.classList.contains("nav-open") && !nav.contains(e.target)) setOpen(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initNav();
      initMsgBadge();
    });
  } else {
    initNav();
    initMsgBadge();
  }
})();
