/* ==========================================================================
   Site-wide inquiry reply notifier (Manara).
   When a visitor submits an inquiry (contact form) we store its secret token
   in localStorage. This script checks those tokens periodically and shows a
   toast "🔔 لديك رد جديد من فريق Manara" the moment the admin replies but the
   user hasn't seen it yet — linking straight to the tracking page.
   Uses fetch() directly (no dependency on api.js) so it can run on any page.
   ========================================================================== */
(function () {
  "use strict";
  var SEEN_PREFIX = "manara_inq_seen_";
  var TOKENS_KEY = "manara_inq_tokens";

  function getTokens() {
    try { return JSON.parse(localStorage.getItem(TOKENS_KEY) || "[]") || []; } catch (e) { return []; }
  }
  function seen(token) { try { return localStorage.getItem(SEEN_PREFIX + token); } catch (e) { return null; } }
  function markSeen(token, repliedAt) { try { localStorage.setItem(SEEN_PREFIX + token, repliedAt || "1"); } catch (e) {} }

  function showToast(token, repliedAt) {
    if (document.getElementById("inqToast-" + token)) return;
    var el = document.createElement("div");
    el.id = "inqToast-" + token;
    el.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10000;" +
      "background:#0f172a;color:#fff;padding:12px 16px;border-radius:14px;font-family:inherit;font-weight:800;" +
      "font-size:14px;box-shadow:0 14px 40px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center;max-width:92vw;";
    var bell = document.createElement("span");
    bell.textContent = "🔔";
    bell.style.fontSize = "18px";
    var txt = document.createElement("span");
    txt.textContent = "لديك رد جديد من فريق Manara";
    var a = document.createElement("a");
    a.href = "/inquiry-track.html?token=" + encodeURIComponent(token);
    a.textContent = "عرض الرد";
    a.style.cssText = "background:#6366f1;color:#fff;padding:7px 14px;border-radius:10px;text-decoration:none;font-weight:800;font-size:13px;white-space:nowrap;";
    el.appendChild(bell); el.appendChild(txt); el.appendChild(a);
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 12000);
    markSeen(token, repliedAt);
  }

  function check() {
    var tokens = getTokens();
    if (!tokens.length) return;
    tokens.forEach(function (token) {
      fetch("/api/inquiries/track/" + encodeURIComponent(token))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.reply && data.repliedAt && seen(token) !== data.repliedAt) {
            showToast(token, data.repliedAt);
          }
        })
        .catch(function () {});
    });
  }

  function start() { check(); setInterval(check, 20000); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
