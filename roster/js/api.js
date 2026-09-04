/* ==========================================================================
   Manara API client — talks to the Node/Express backend.
   Base URL: /api when served by the server, overridable via window.API_BASE.
   Works in offline/file:// mode too: every method returns a Promise and the
   caller decides how to fall back.
   ========================================================================== */
(function () {
  "use strict";

  var BASE = (window.API_BASE || "/api").replace(/\/$/, "");
  // The JWT now lives in an httpOnly cookie (server-set) that JavaScript can
  // never read — an XSS payload can't steal it. For the few places that need a
  // *synchronous-ish* identity before /auth/me resolves (bubble alignment,
  // club-only widgets), we keep a NON-SENSITIVE session marker { id, role }
  // only — never the token itself.
  var SESSION_KEY = "manara_session";

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null") || {}; } catch (e) { return {}; }
  }
  function setSession(s) {
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify({ id: s.id || null, role: s.role || null })); else localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  // Presence check for the "am I signed in" guards scattered across pages.
  // No longer returns the JWT — always a marker, never the token.
  function getToken() {
    var s = getSession();
    return s && s.id ? String(s.id) : "";
  }

  function request(method, path, body, auth, timeoutMs) {
    // Opening the page from the file system: /api resolves to file:///api which always fails.
    if (window.location.protocol === "file:") {
      return Promise.reject(new Error("يجب فتح الموقع من خلال السيرفر — شغّل `npm start` داخل مجلد server ثم افتح http://localhost:5000"));
    }

    var opts = { method: method, headers: { "Accept": "application/json" }, credentials: "include" };
    if (body && !(body instanceof FormData)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    // No manual Authorization header: the server reads the httpOnly cookie.

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ctrl) { opts.signal = ctrl.signal; }
    // Uploads (large videos) get a much longer timeout than regular API calls.
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 15000);

    return fetch(BASE + path, opts)
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error((data && (data.error || data.message)) || ("Request failed (" + res.status + ")"));
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.status) throw err; // server answered with an error -> keep its message
        if (ctrl && ctrl.signal.aborted) {
          throw new Error("الخادم لا يستجيب — تأكد أن السيرفر شغال ثم أعد المحاولة");
        }
        if (err instanceof TypeError) {
          throw new Error("تعذر الاتصال بالخادم — تأكد أن السيرفر يعمل على http://localhost:5000 ثم أعد المحاولة");
        }
        throw err;
      })
      .finally(function () { clearTimeout(timer); });
  }

  // XHR-based upload with REAL network progress (fetch cannot report upload
  // progress). Mirrors request() error semantics: rejects with Error carrying
  // .status and the server's message when available.
  function xhrUpload(path, formData, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", BASE + path);
      xhr.withCredentials = true; // session rides in the httpOnly cookie
      xhr.timeout = opts.timeoutMs || 600000;
      if (typeof opts.onProgress === "function") {
        xhr.upload.addEventListener("progress", function (e) {
          if (e.lengthComputable) opts.onProgress(Math.round((e.loaded / e.total) * 100));
        });
      }
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText || "{}"); } catch (e) { /* non-JSON body */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        var err = new Error((data && (data.error || data.message)) || ("Request failed (" + xhr.status + ")"));
        err.status = xhr.status;
        err.data = data;
        reject(err);
      };
      xhr.onerror = function () {
        reject(new Error("تعذر الاتصال بالخادم — تأكد أن السيرفر يعمل على http://localhost:5000 ثم أعد المحاولة"));
      };
      xhr.ontimeout = function () {
        reject(new Error("الخادم لا يستجيب — تأكد أن السيرفر شغال ثم أعد المحاولة"));
      };
      xhr.send(formData);
    });
  }

  window.API = {
    base: BASE,
    token: getToken,
    session: getSession,
    login: function (email, password) {
      return request("POST", "/auth/login", { email: email, password: password }).then(function (res) {
        if (res.user) setSession({ id: res.user.id, role: res.user.role });
        return res;
      });
    },
    logout: function () {
      // Clear the httpOnly cookie on the server, then drop the local marker.
      request("POST", "/auth/logout", {}).catch(function () {});
      setSession(null);
    },
    getMe: function () { return request("GET", "/auth/me", null, true); },
    register: function (data, role) {
      // Server returns { status:"pending", registrationId, message } — no token
      // until an admin approves the request.
      return request("POST", "/auth/register", { role: role, data: data });
    },
    uploadRegister: function (formData, purpose, onProgress) {
      // No-auth upload for proof documents / photo / videos used by sign-up
      // (before the account exists). Long timeout: a 1-10 min highlight video
      // takes a while to transfer + validate. onProgress(0..100) is real
      // network progress reported by xhr.upload.onprogress.
      if (purpose) formData.append("purpose", purpose);
      return xhrUpload("/upload/register-upload", formData, { onProgress: onProgress, timeoutMs: 10 * 60 * 1000 });
    },
    getPlayers: function (params) {
      var qs = params ? "?" + params.toString() : "";
      return request("GET", "/players" + qs);
    },
    getStats: function () { return request("GET", "/stats"); },
    getPlayer: function (id) { return request("GET", "/players/" + encodeURIComponent(id), null, true); },
    ratePlayer: function (id, data) {
      return request("POST", "/players/" + encodeURIComponent(id) + "/review", data, true);
    },
    shortlistPlayer: function (id, isIn) {
      return request("POST", "/players/" + encodeURIComponent(id) + "/shortlist", { in: !!isIn }, true);
    },
    scoutNote: function (id, note) {
      return request("PUT", "/players/" + encodeURIComponent(id) + "/scout-note", { note: note }, true);
    },
    createPlayer: function (data) { return request("POST", "/players", data, true); },
    updatePlayer: function (id, data) { return request("PUT", "/players/" + encodeURIComponent(id), data, true); },
    getClubs: function (params) {
      var qs = params ? "?" + params.toString() : "";
      return request("GET", "/clubs" + qs);
    },
    getClub: function (id) { return request("GET", "/clubs/" + encodeURIComponent(id), null, true); },
    createClub: function (data) { return request("POST", "/clubs", data, true); },
    updateClub: function (id, data) { return request("PUT", "/clubs/" + encodeURIComponent(id), data, true); },
    sendMessage: function (toUserId, playerId, text) {
      return request("POST", "/messages", { toUserId: toUserId, playerId: playerId, text: text }, true);
    },
    getThreads: function () { return request("GET", "/messages/threads", null, true); },
    getConversation: function (otherUserId, playerId, opts) {
      var qs = "?to=" + encodeURIComponent(otherUserId);
      if (playerId) qs += "&player=" + encodeURIComponent(playerId);
      if (opts) {
        if (opts.page) qs += "&page=" + encodeURIComponent(opts.page);
        if (opts.limit) qs += "&limit=" + encodeURIComponent(opts.limit);
      }
      return request("GET", "/messages" + qs, null, true);
    },
    getUnreadCount: function () {
      return request("GET", "/messages/unread-count", null, true);
    },
    createApplication: function (playerId, type, message) {
      return request("POST", "/applications", { playerId: playerId, type: type, message: message }, true);
    },
    getApplications: function () { return request("GET", "/applications", null, true); },
    upload: function (formData, purpose, onProgress) {
      if (purpose) formData.append("purpose", purpose);
      return xhrUpload("/upload", formData, { auth: true, onProgress: onProgress, timeoutMs: 10 * 60 * 1000 });
    },
    adminRegistrations: function (status) {
      var qs = status && status !== "all" ? "?status=" + encodeURIComponent(status) : "";
      return request("GET", "/admin/registrations" + qs, null, true);
    },
    adminApprove: function (id) {
      return request("POST", "/admin/registrations/" + encodeURIComponent(id) + "/approve", {}, true);
    },
    adminReject: function (id, note) {
      return request("POST", "/admin/registrations/" + encodeURIComponent(id) + "/reject", { note: note }, true);
    },
    subscriptionStatus: function () {
      return request("GET", "/subscription/status", null, true);
    },
    subscriptionCancel: function () {
      return request("POST", "/subscription/cancel", {}, true);
    },
    subscriptionResume: function () {
      return request("POST", "/subscription/resume", {}, true);
    },
    subscriptionChat: function (message) {
      return request("POST", "/subscription/chat", { message: message }, true);
    },
    submitPayment: function (payload) {
      return request("POST", "/subscription/submit-payment", payload, true);
    },
    kashierCheckout: function () {
      return request("POST", "/payments/kashier/checkout", {}, true, 20000);
    },
    myChats: function () {
      return request("GET", "/subscription/my-chats", null, true);
    },
    adminTransactions: function (status) {
      var qs = status && status !== "all" ? "?status=" + encodeURIComponent(status) : "";
      return request("GET", "/admin/transactions" + qs, null, true);
    },
    adminApproveTransaction: function (id) {
      return request("POST", "/admin/transactions/" + encodeURIComponent(id) + "/approve", {}, true);
    },
    adminRejectTransaction: function (id, note) {
      return request("POST", "/admin/transactions/" + encodeURIComponent(id) + "/reject", { note: note }, true);
    },
    adminDeclarationsStatus: function () {
      return request("GET", "/admin/declarations/status", null, true);
    },
    adminDeclarationsUnlock: function (p1, p2, p3) {
      return request("POST", "/admin/declarations/unlock", { p1: p1, p2: p2, p3: p3 }, true);
    },
    adminDeclarationFile: function (id, declToken) {
      return fetch(BASE + "/admin/declarations/" + encodeURIComponent(id), {
        credentials: "include",
        headers: { "x-decl-token": declToken, "Accept": "*/*" }
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error((data && data.error) || ("Request failed (" + res.status + ")"));
          });
        }
        return res.blob().then(function (blob) {
          return { blob: blob, mimetype: res.headers.get("Content-Type") || "" };
        });
      });
    },
    forgotPassword: function (email) {
      return request("POST", "/auth/forgot-password", { email: email });
    },
    resetPassword: function (code, newPassword, newPasswordConfirm) {
      return request("POST", "/auth/reset-password", { code: code, newPassword: newPassword, newPasswordConfirm: newPasswordConfirm });
    },
    sendVerification: function (email) {
      return request("POST", "/auth/send-verification", { email: email });
    },
    verifyEmail: function (verificationId, code) {
      return request("POST", "/auth/verify-email", { verificationId: verificationId, code: code });
    },
    deleteAccount: function () {
      return request("DELETE", "/auth/account", null, true).then(function () { setSession(null); return true; });
    },
    clubDelete: function (id) {
      return request("DELETE", "/clubs/" + encodeURIComponent(id), null, true);
    },
    submitInquiry: function (data) {
      return request("POST", "/inquiries", data);
    },
    getInquiryByToken: function (token) {
      return request("GET", "/inquiries/track/" + encodeURIComponent(token));
    },
    adminInquiries: function (status) {
      var qs = status && status !== "all" ? "?status=" + encodeURIComponent(status) : "";
      return request("GET", "/admin/inquiries" + qs, null, true);
    },
    adminInquiry: function (id) {
      return request("GET", "/admin/inquiries/" + encodeURIComponent(id), null, true);
    },
    adminReplyInquiry: function (id, reply) {
      return request("POST", "/admin/inquiries/" + encodeURIComponent(id) + "/reply", { reply: reply }, true);
    },
    aiChat: function (message, history) {
      return request("POST", "/ai/chat", { message: message, history: history || [] }, true);
    },
    adminDeleteUser: function (id) {
      return request("DELETE", "/admin/users/" + encodeURIComponent(id), null, true);
    },
    adminLogs: function () {
      return request("GET", "/admin/logs", null, true);
    }
  };
})();