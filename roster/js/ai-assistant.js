/* ==========================================================================
   Manara AI Assistant — front-end chat controller.
   - Requires an authenticated user (Bearer token from api.js). If not signed
     in, the composer is disabled with a sign-in prompt.
   - Handles empty / too-long input, loading, error and rejection states.
   - Sends the recent conversation as `history` for context, but never sends
     the API key (it lives only on the server).
   ========================================================================== */
(function () {
  "use strict";
  var log = document.getElementById("aiLog");
  var empty = document.getElementById("aiEmpty");
  var form = document.getElementById("aiForm");
  var text = document.getElementById("aiText");
  var sendBtn = document.getElementById("aiSend");
  var history = [];

  function token() {
    // Defer to the shared API client so detection is identical to every other
    // page (nav-auth.js / main.js use the same storage key).
    if (window.API && typeof API.token === "function") {
      try { return API.token() || ""; } catch (e) {}
    }
    // Fallback if the shared client is unavailable: read the NON-SENSITIVE
    // session marker (never the httpOnly JWT).
    try { var s = JSON.parse(localStorage.getItem("manara_session") || "null") || {}; return s.id || ""; } catch (e) { return ""; }
  }

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function addMessage(role, content, extraClass) {
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var el = document.createElement("div");
    el.className = "ai-msg " + (role === "user" ? "user" : "bot") + (extraClass ? " " + extraClass : "");
    el.textContent = content;
    log.appendChild(el);
    scrollDown();
    return el;
  }

  function showTyping() {
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var el = document.createElement("div");
    el.className = "ai-msg bot";
    el.id = "aiTyping";
    el.innerHTML = '<span class="ai-typing"><span></span><span></span><span></span></span>';
    log.appendChild(el);
    scrollDown();
  }
  function hideTyping() {
    var t = document.getElementById("aiTyping");
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    text.disabled = busy;
    if (!busy) text.focus();
  }

  function requireLogin() {
    if (token()) return true;
    addMessage("bot", "يرجى تسجيل الدخول أولاً لاستخدام مساعد منارة.", "error");
    var a = document.createElement("div");
    a.className = "ai-msg bot";
    a.innerHTML = '<a class="btn btn-primary btn-pill" href="Sign/Sign_In.html">تسجيل الدخول</a>';
    log.appendChild(a);
    setBusy(true);
    return false;
  }

  function autoGrow() {
    text.style.height = "auto";
    text.style.height = Math.min(text.scrollHeight, 120) + "px";
  }

  text.addEventListener("input", autoGrow);
  text.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = text.value.trim();
    if (!msg) return;
    if (msg.length > 2000) {
      addMessage("bot", "الرسالة طويلة جداً — الحد الأقصى 2000 حرف.", "error");
      return;
    }
    if (!requireLogin()) return;

    addMessage("user", msg);
    history.push({ role: "user", content: msg });
    text.value = "";
    autoGrow();
    setBusy(true);
    showTyping();

    API.aiChat(msg, history)
      .then(function (res) {
        hideTyping();
        var reply = (res && res.reply) || "عذرًا، لم أتمكن من الرد الآن.";
        var cls = (res && res.scope === "offtopic") ? "reject" : "";
        addMessage("bot", reply, cls);
        history.push({ role: "assistant", content: reply });
        if (history.length > 12) history = history.slice(-12);
      })
      .catch(function (err) {
        hideTyping();
        var msg2 = (err && err.message) || "تعذر الاتصال بالخادم.";
        if (err && err.status === 401) {
          addMessage("bot", "انتهت جلستك — يرجى تسجيل الدخول مرة أخرى.", "error");
          var link = document.createElement("div");
          link.className = "ai-msg bot";
          link.innerHTML = '<a class="btn btn-primary btn-pill" href="Sign/Sign_In.html">تسجيل الدخول</a>';
          log.appendChild(link);
          setBusy(true);
        } else if (err && err.status === 402) {
          addMessage("bot", "انتهت تجربتك المجانية — اشترك لاستخدام المساعد الذكي.", "error");
          var pay = document.createElement("div");
          pay.className = "ai-msg bot";
          pay.innerHTML = '<a class="btn btn-primary btn-pill" href="subscribe.html">الاشتراك</a>';
          log.appendChild(pay);
          setBusy(true);
        } else if (err && err.status === 429) {
          addMessage("bot", "طلبات كثيرة إلى المساعد — حاول بعد قليل.", "error");
        } else {
          addMessage("bot", msg2, "error");
        }
      })
      .then(function () { setBusy(false); });
  });

  // If already signed in, focus the composer; otherwise show a hint once.
  if (!token()) {
    addMessage("bot", "مرحباً 👋 أنا مساعد منارة. سجّل الدخول لأبدأ بالإجابة عن أسئلتك عن المنصة.", "reject");
  } else {
    text.focus();
  }
})();
