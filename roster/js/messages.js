/* ==========================================================================
   Messages page — Manara in-app chat.
   Rules enforced both here (UX) and on the server (security):
     • Clubs can initiate and send messages.
     • Players can only REPLY to a club that already wrote to them.
     • Contact-solicitation phrases are blocked with a visible error.
   ========================================================================== */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var now = new Date();
    var hm = d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return hm;
    var opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("ar-EG", opts) + " " + hm;
  }

  var me = null;
  var threads = [];
  var active = null; // { toUserId, playerId, peerName, playerName }
  var messages = [];
  var lastMsgsSig = "";
  var lastThreadsSig = "";
  var timers = [];

  function signature(msgs) {
    return msgs.map(function (m) { return m.id + ":" + m.createdAt; }).join("|");
  }
  function threadSignature(list) {
    return list.map(function (t) { return t.key + ":" + t.lastAt + ":" + (t.lastMessage || ""); }).join("|");
  }

  function getParam(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }

  // Synchronous user id from the NON-SENSITIVE session marker — so bubbles
  // are aligned (mine / theirs) even before the /auth/me response arrives.
  // The JWT itself stays in an httpOnly cookie and is never read here.
  function myUserId() {
    try {
      var s = window.API.session ? window.API.session() : {};
      return s && s.id ? s.id : null;
    } catch (e) { return null; }
  }

  function initAuthNav() {
    if (!window.API || !window.API.token()) {
      window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    // Provisional identity straight from the NON-SENSITIVE session marker
    // (id + role) — role logic and bubble alignment work before /auth/me
    // resolves, without ever reading the httpOnly JWT.
    try {
      var s = window.API.session ? window.API.session() : {};
      me = { id: s.id || null, role: s.role || null, name: "" };
    } catch (e) {}
    var nameEl = $("authUserName");
    window.API.getMe().then(function (res) {
      me = res && res.user;
      if (!me) return;
      if (nameEl) nameEl.textContent = "👤 " + me.name;
      var sl = $("navShortlist");
      if (sl) sl.style.display = (me.role === "club") ? "" : "none";
      var badge = $("roleBadge");
      if (badge) {
        badge.textContent = me.role === "club" ? "🏟️ نادي — يمكنك بدء المحادثات" : "🏅 لاعب — رد على رسائل النادي";
      }
      var findBtn = $("findPeopleBtn");
      if (findBtn) {
        if (me.role === "club") {
          findBtn.href = "jobs.html";
          findBtn.innerHTML = "🔍 البحث عن لاعبين";
        } else {
          findBtn.href = "clubs.html";
          findBtn.innerHTML = "🏟️ تصفح الأندية";
        }
      }
      updateComposerState();
    }).catch(function () {});
    var logoutBtn = $("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", function () {
      window.API.logout();
      window.location.href = "index.html";
    });
  }

  function renderThreads() {
    var list = $("threadList");
    if (!list) return;
    if (!threads.length) {
      list.innerHTML = '<div class="thread-empty">لا توجد محادثات بعد<br><span style="font-weight:400;font-size:12.5px">' +
        (me && me.role === "club"
          ? "افتح ملف لاعب من صفحة «Players» واضغط زر المراسلة للبدء"
          : "عندما يرسل إليك نادٍ رسالة ستظهر هنا للرد عليها") +
        "</span></div>";
      return;
    }
    list.innerHTML = threads.map(function (t) {
      var activeKey = active && t.key === (active.playerId || "") + "|" + active.toUserId;
      return '<button type="button" class="thread-item' + (activeKey ? " active" : "") + '" data-key="' + esc(t.key) + '">' +
        '<span class="thread-ava">' + esc((t.peer && t.peer.name ? t.peer.name : "؟").slice(0, 1)) + "</span>" +
        '<span class="thread-body"><b class="thread-name">' + esc(t.peer ? t.peer.name : "مستخدم") + "</b>" +
        (t.player && t.player.name ? '<span class="thread-player">← ' + esc(t.player.name) + "</span>" : "") +
        '<span class="thread-last">' + esc(t.lastMessage || "") + "</span></span>" +
        '<span class="thread-time">' + fmtTime(t.lastAt) + "</span>" +
        "</button>";
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll(".thread-item"), function (btn) {
      btn.addEventListener("click", function () {
        var t = threads.find(function (x) { return x.key === btn.getAttribute("data-key"); });
        if (t) openThread(t.peer.id, t.player ? t.player.id : null, t.peer.name, t.player ? t.player.name : null);
      });
    });
  }

  function openThread(toUserId, playerId, peerName, playerName) {
    active = { toUserId: toUserId, playerId: playerId, peerName: peerName, playerName: playerName };
    var head = $("chatHead");
    if (head) {
      head.innerHTML = '<span class="chat-head-title">' + esc(peerName || "محادثة") +
        (playerName ? " <small>← " + esc(playerName) + "</small>" : "") + "</span>";
    }
    loadMessages();
    updateComposerState();
    renderThreads();
  }

  // Fetch a whole conversation across pages (server caps at 50/page, so a
  // thread longer than that needs repeated requests — otherwise the newest
  // messages would never render).
  function loadAllMessages(toUserId, playerId) {
    var all = [];
    var page = 1;
    var step = function () {
      return window.API.getConversation(toUserId, playerId, { page: page, limit: 50 })
        .then(function (res) {
          var msgs = (res && res.messages) || [];
          all = all.concat(msgs);
          var total = (res && res.total) || 0;
          if (all.length < total && msgs.length) {
            page += 1;
            return step();
          }
          return all;
        });
    };
    return step();
  }

  function loadMessages(silent) {
    if (!active) return;
    if (!silent) {
      var box = $("chatMsgs");
      if (box) box.innerHTML = '<div class="chat-empty">جاري التحميل…</div>';
    }
    loadAllMessages(active.toUserId, active.playerId).then(function (msgs) {
      var sig = signature(msgs);
      if (sig !== lastMsgsSig) {
        messages = msgs;
        renderMessages();
        lastMsgsSig = sig;
        if (window.__msgBadgeRefresh) window.__msgBadgeRefresh();
      }
      updateComposerState();
    }).catch(function (err) {
      if (err && err.status === 402) { window.location.replace("subscribe.html"); return; }
      showErr((err && err.message) || "تعذر تحميل الرسائل");
      updateComposerState();
    });
  }

  function renderMessages() {
    var box = $("chatMsgs");
    if (!box) return;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (!messages.length) {
      box.innerHTML = '<div class="chat-empty">لا رسائل بعد — ' +
        (me && me.role === "club" ? "أرسل أول رسالة للبدء" : "بانتظار رسالة من النادي") + "</div>";
      return;
    }
    box.innerHTML = messages.map(function (m) {
      var mine = m.fromUserId === (me && me.id) || m.fromUserId === myUserId();
      var who = mine ? "أنت" : (m.senderRole === "club" ? "النادي" : "اللاعب");
      return '<div class="bubble-wrap ' + (mine ? "mine" : "theirs") + '">' +
        '<div class="bubble ' + (mine ? "sent" : "recv") + '">' + esc(m.text) + "</div>" +
        '<span class="bubble-meta">' + esc(who) + " · " + fmtTime(m.createdAt) + "</span></div>";
    }).join("");
    box.scrollTop = nearBottom ? box.scrollHeight : box.scrollTop;
  }

  function updateComposerState() {
    var composer = $("composer");
    var input = $("msgInput");
    var sendBtn = $("sendBtn");
    var notice = $("replyNotice");
    if (!composer || !input || !sendBtn) return;
    var canSend = !!active;
    if (canSend && me && me.role === "player") {
      // players may only reply once a club message exists in this thread
      canSend = messages.some(function (m) { return m.senderRole === "club"; });
    }
    composer.style.display = active ? "flex" : "none";
    if (notice) notice.style.display = active && !canSend ? "block" : "none";
    input.disabled = !canSend;
    sendBtn.disabled = !canSend;
  }

  function showErr(msg) {
    var e = $("chatErr");
    if (!e) return;
    e.textContent = "⚠️ " + msg;
    e.style.display = "block";
  }
  function clearErr() {
    var e = $("chatErr");
    if (e) e.style.display = "none";
  }

  function bindComposer() {
    var form = $("composer");
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = $("msgInput");
      if (!input || !active) return;
      var text = input.value.trim();
      if (!text) return;
      clearErr();
      var btn = $("sendBtn");
      if (btn) btn.disabled = true;
      window.API.sendMessage(active.toUserId, active.playerId, text).then(function () {
        input.value = "";
        loadMessages(true);
        loadThreads(true);
      }).catch(function (err) {
        if (btn) btn.disabled = false;
        if (err && err.status === 402) { window.location.replace("subscribe.html"); return; }
        showErr((err && err.message) || "تعذر إرسال الرسالة");
        updateComposerState();
      });
    });
  }

  function loadThreads(silent) {
    return window.API.getThreads().then(function (res) {
      var list = (res && res.threads) || [];
      var sig = threadSignature(list);
      if (silent && sig === lastThreadsSig) return;
      threads = list;
      lastThreadsSig = sig;
      renderThreads();
    }).catch(function (err) {
      // Paywall: a locked-out account can't read messages.
      if (err && err.status === 402) { window.location.replace("subscribe.html"); return; }
    });
  }

  // A club landed here with ?player=<id> (from the "Message" button on a
  // player profile) — open the thread with that player's account. The URL
  // carries the public slug, so resolve it to the internal id first (the
  // messaging API stores player ids, not slugs).
  function handlePlayerParam() {
    var qPlayer = getParam("player");
    if (!qPlayer || !me || me.role !== "club") return;
    window.API.getPlayer(qPlayer).then(function (res) {
      var p = res && (res.player || res.data);
      if (!p) return;
      var playerId = p.id;
      var existing = threads.find(function (t) { return t.player && t.player.id === playerId; });
      if (existing) {
        openThread(existing.peer.id, playerId, existing.peer.name, existing.player.name);
        return;
      }
      if (p.userId) openThread(p.userId, playerId, p.name, p.name);
      else openThread(qPlayer, playerId, p.name, p.name);
    }).catch(function () {});
  }

  function init() {
    initAuthNav();
    bindComposer();
    loadThreads().then(function () {
      handlePlayerParam();
      if (!active && threads.length) {
        var t = threads[0];
        openThread(t.peer.id, t.player ? t.player.id : null, t.peer.name, t.player ? t.player.name : null);
      }
      updateComposerState();
    });

    // Live updates: poll the open conversation + thread list so new
    // messages appear without a manual refresh.
    timers.push(setInterval(function () {
      if (active) loadMessages(true);
    }, 3000));
    timers.push(setInterval(function () {
      loadThreads(true);
    }, 5000));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
