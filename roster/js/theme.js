/* ==========================================================================
   Manara — theme (light / dark) switcher.
   Persists the choice in localStorage and defaults to the OS preference.
   Loaded in <head> so the theme is applied before first paint (no flash).
   ========================================================================== */
(function () {
  "use strict";

  var KEY = "manara_theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") || "light";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    var btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  }

  function init() {
    document.documentElement.classList.add("js");
    var qp = null;
    try { qp = new URLSearchParams(window.location.search).get("theme"); } catch (e) {}
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var theme = (qp === "dark" || qp === "light")
      ? qp
      : (saved === "dark" || saved === "light"
        ? saved
        : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    apply(theme);

    var btn = document.getElementById("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        apply(current() === "dark" ? "light" : "dark");
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();