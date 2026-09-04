/* ==========================================================================
   Manara — auth-aware navbar swap (shared).
   Pages built from a STATIC nav partial (e.g. clubs.html) otherwise always
   show "Sign in" / "Sign Up" even when the visitor is already signed in,
   because only main.js-powered pages ran this logic. This self-contained
   module mirrors main.js initAuthNav(): when a valid session exists it
   replaces the .nav-cta with the user's name + a logout button, and points
   "My Profile" at the right dashboard. Logged-out visitors keep the static
   links untouched.
   ========================================================================== */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function apply() {
    if (!window.API) return;
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

    // Logged out: leave the static "Sign in" / "Sign Up" links as they are.
    if (!window.API.token()) {
      setHref(null, false, false);
      setShortlist(false);
      return;
    }

    window.API.getMe().then(function (res) {
      var user = res && res.user;
      var profile = res && res.profile;
      var isClub = !!(profile && profile.id && profile.id.indexOf("c_") === 0);
      var isAdmin = !!(user && user.role === "admin");
      if (cta) {
        cta.innerHTML =
          (user ? '<span class="signin" style="cursor:default">👤 ' + esc(user.name) + "</span>" : "") +
          '<button class="btn btn-outline-ink btn-pill" id="logoutBtn" type="button">Logout</button>';
        var lb = document.getElementById("logoutBtn");
        if (lb) lb.addEventListener("click", function () {
          window.API.logout();
          window.location.href = "Sign/Sign_In.html";
        });
      }
      setShortlist(isClub);
      setHref(profile && (profile.slug || profile.id) ? (profile.slug || profile.id) : null, isClub, isAdmin);
    }).catch(function () {
      setHref(null);
      setShortlist(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
