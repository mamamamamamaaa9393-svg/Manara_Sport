/* ==========================================================================
   Manara player profile page — loads a player from the API and fills every
   section (name, tags, quick stats, bio, videos, quick info, contact,
   rating, documents). When no ?player= param or the API is unavailable,
   the static sample profile from the HTML stays as a design fallback.
   ========================================================================== */
(function () {
  "use strict";

  var SPORT_AR = {
    Football: "⚽ كرة القدم", Basketball: "🏀 كرة السلة", Tennis: "🎾 التنس",
    Volleyball: "🏐 الكرة الطائرة", Handball: "🤾 كرة اليد", Golf: "⛳ الجولف",
    Karate: "🥋 الكاراتيه", Swimming: "🏊 السباحة", "Multi-sport": "🏅 متعدد الرياضات"
  };
  var LEVEL_AR = {
    Pro: "🏆 محترف", "Semi-pro": "🏅 شبه محترف", Amateur: "⭐ هاوٍ",
    Beginner: "🌱 مبتدئ", International: "💎 دولي"
  };

  var meRole = null;
  var viewedPlayer = null; // { id, isOwner } for the profile currently shown
  var scoutNote = null; // private scout note owned by the browsing club

  // Synchronous role from the NON-SENSITIVE session marker (id + role only,
  // never the JWT) — lets club-only widgets (rating, shortlist, scout notes)
  // render before /auth/me resolves without exposing the httpOnly token.
  function syncRoleFromToken() {
    try {
      var s = window.API.session ? window.API.session() : {};
      return (s && s.role) || null;
    } catch (e) { return null; }
  }

  function ar(sport) { return SPORT_AR[sport] || sport; }
  function lvl(level) { return LEVEL_AR[level] || level; }

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
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

  function fmtDur(sec) {
    if (!sec) return "";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function set(sel, val) {
    var el = document.querySelector(sel);
    if (el && val != null) el.textContent = val;
  }

  function setMeta(prop, content) {
    var el = document.querySelector('meta[property="' + prop + '"]');
    if (el && content) el.setAttribute("content", content);
  }

  // Declare the crawlable canonical URL so the JS app page isn't treated as a
  // duplicate of the server-rendered /player/<slug> profile.
  function setCanonical(href) {
    var el = document.querySelector('link[rel="canonical"]');
    if (!el) { el = document.createElement("link"); el.rel = "canonical"; document.head.appendChild(el); }
    el.setAttribute("href", href);
  }

  // Small transient toast (used by the rating flow + in-app notifications).
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

  // Private documents (declaration image, proofs) are protected on the server
  // and require the owner's token. Returns a blob URL for /uploads files.
  function authedUrl(url) {
    if (!url || url.indexOf("/uploads/") !== 0) return Promise.resolve(url);
    return fetch(url, { credentials: "include", headers: { "Accept": "*/*" } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then(function (blob) { return URL.createObjectURL(blob); });
  }

  // Owner-only proof documents open through an authenticated fetch.
  document.addEventListener("click", function (e) {
    var a = e.target.closest('.doc a.view[href*="/uploads/"]');
    if (!a) return;
    e.preventDefault();
    authedUrl(a.getAttribute("href")).then(function (blobUrl) {
      var w = window.open(blobUrl, "_blank");
      if (!w) window.location.href = blobUrl;
    }).catch(function () {});
  });

  function init() {
    // Profiles are private: signed-out visitors are sent to the login page.
    if (!window.API || !window.API.token()) {
      window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    initAuthNav();
    wireShare();
    meRole = meRole || syncRoleFromToken();

    var goLogin = function () {
      if (window.API && window.API.logout) window.API.logout();
      window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
    };

    var params = new URLSearchParams(window.location.search);
    var id = params.get("player");
    if (!id) {
      // "My Profile": load the signed-in user's own player profile.
      window.API.getMe().then(function (me) {
        if (!me || !me.user) { goLogin(); return; }
        var own = me && me.profile;
        var role = me && me.user && me.user.role;
        if (role === "admin") { showAdminHome(); return; }
        if (own && own.id && own.id.indexOf("c_") === 0) {
          window.location.replace("club-profile.html");
        } else if (own && own.id && own.id.indexOf("p_") === 0) {
          window.location.replace("profile.html?player=" + encodeURIComponent(own.slug || own.id));
        } else {
          showNoProfile();
        }
      }).catch(function () {
        // Invalid / expired session: never fall back to the static demo
        // profile — clear the stale token and ask the visitor to sign in.
        goLogin();
      });
      return;
    }

    window.API.getPlayer(id)
      .then(function (res) {
        var p = res && (res.player || res.data);
        if (!p) return;
        viewedPlayer = { id: id, isOwner: !!(res && res.owner) };
        fillProfile(p, viewedPlayer.isOwner, res);
        ensureMessageBtn();
      })
      .catch(function (err) {
        // Paywall: a locked-out owner can't view their own profile.
        if (err && err.status === 402) {
          window.location.replace("subscribe.html");
          return;
        }
        // Expired / invalid session -> clear the stale token and sign in.
        // Any other failure (404 bad slug, network error) must never leave
        // the static sample profile visible as if it were real data.
        if (err && (err.status === 401 || err.status === 403)) {
          goLogin();
          return;
        }
        showProfileError();
      });
  }

  // Copy the shareable profile link (used on the profile page's Share button).
  function wireShare() {
    var btn = document.getElementById("shareBtn");
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", function () {
      var url = window.location.href;
      if (navigator.share) {
        navigator.share({ title: document.title, url: url }).catch(function () {});
        return;
      }
      var done = function () {
        toast("✅ تم نسخ رابط الملف — شاركه مع الأندية");
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(function () { fallbackCopy(url, done); });
      } else {
        fallbackCopy(url, done);
      }
    });
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  // Club-only toggle: add/remove this player to the club's private shortlist.
  var shortlisted = false;
  function wireShortlist(initial) {
    var btn = document.getElementById("shortlistBtn");
    if (!btn || !window.API) return;
    shortlisted = !!initial;
    btn.style.display = "inline-flex";
    var paint = function () {
      btn.innerHTML = shortlisted ? "⭐ في القائمة المختصرة ✓" : "⭐ قائمة مختصرة";
      btn.style.background = shortlisted ? "var(--gray-200)" : "";
    };
    paint();
    btn.addEventListener("click", function () {
      btn.disabled = true;
      window.API.shortlistPlayer(viewedPlayer.id, !shortlisted).then(function (r) {
        shortlisted = !!r.shortlisted;
        paint();
        toast(shortlisted ? "✅ أُضيف اللاعب إلى القائمة المختصرة" : "تمت الإزالة من القائمة المختصرة");
      }).catch(function (err) {
        toast("❌ " + (err.message || "تعذر تحديث القائمة المختصرة"), true);
      }).finally(function () { btn.disabled = false; });
    });
  }

  function showAdminHome() {
    var c = document.querySelector(".container");
    if (!c) return;
    c.innerHTML =
      '<div style="max-width:560px;margin:60px auto;padding:40px 24px;text-align:center;background:var(--surface);border:1px solid var(--gray-200);border-radius:16px;box-shadow:var(--shadow-md);">' +
      '<div style="font-size:44px;margin-bottom:10px;">🛡️</div>' +
      '<h2 style="font-family:Inter,sans-serif;font-size:20px;font-weight:900;color:var(--dark);">هذا حساب إداري</h2>' +
      '<p style="color:var(--gray-500);font-weight:600;margin:10px 0 22px;line-height:1.7;">حساب الأدمن لا يملك ملفاً رياضياً. استخدم لوحة الإدارة لمراجعة طلبات التسجيل وقبولها أو رفضها.</p>' +
      '<a href="admin.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🛡️ فتح لوحة الإدارة</a>' +
      '</div>';
  }

  function showNoProfile() {
    var c = document.querySelector(".container");
    if (!c) return;
    c.innerHTML =
      '<div style="max-width:560px;margin:60px auto;padding:40px 24px;text-align:center;background:var(--surface);border:1px solid var(--gray-200);border-radius:16px;box-shadow:var(--shadow-md);">' +
      '<div style="font-size:44px;margin-bottom:10px;">🏅</div>' +
      '<h2 style="font-family:Inter,sans-serif;font-size:20px;font-weight:900;color:var(--dark);">ليس لديك ملف رياضي بعد</h2>' +
      '<p style="color:var(--gray-500);font-weight:600;margin:10px 0 22px;line-height:1.7;">هذا الحساب غير مرتبط بملف رياضي. سجّل كرياضي لإنشاء ملفك وإضافة فيديوهاتك وإحصائياتك.</p>' +
      '<a href="Sign/Sign_Up.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🏅 أنشئ ملفك الرياضي</a>' +
      '</div>';
  }

  // A failed profile load (404 bad slug, network error, ...) must never leave
  // the static sample profile on screen as if it were real data.
  function showProfileError() {
    var c = document.querySelector(".container");
    if (!c) return;
    c.innerHTML =
      '<div style="max-width:560px;margin:60px auto;padding:40px 24px;text-align:center;background:var(--surface);border:1px solid var(--gray-200);border-radius:16px;box-shadow:var(--shadow-md);">' +
      '<div style="font-size:44px;margin-bottom:10px;">🔍</div>' +
      '<h2 style="font-family:Inter,sans-serif;font-size:20px;font-weight:900;color:var(--dark);">لم يتم العثور على الملف</h2>' +
      '<p style="color:var(--gray-500);font-weight:600;margin:10px 0 22px;line-height:1.7;">هذا الملف غير متاح أو لم يعد موجوداً — تصفح ملفات اللاعبين المتاحة.</p>' +
      '<a href="jobs.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">⚽ تصفح اللاعبين</a>' +
      '</div>';
  }

  function initAuthNav() {
    var nameEl = document.getElementById("authUserName");
    var logoutBtn = document.getElementById("logoutBtn");
    if (!window.API || !window.API.token()) return;
    window.API.getMe().then(function (res) {
      var user = res && res.user;
      meRole = user && user.role;
      if (nameEl && user && user.name) nameEl.textContent = "👤 " + user.name;
      var sl = document.getElementById("navShortlist");
      if (sl) sl.style.display = (meRole === "club") ? "" : "none";
      ensureMessageBtn();
    }).catch(function () {});
    if (logoutBtn) logoutBtn.addEventListener("click", function () {
      window.API.logout();
      window.location.href = "Sign/Sign_In.html";
    });
  }

  function fillProfile(p, isOwner, res) {
    document.title = (p.name || "ملف رياضي") + " | Manara";

    // Private shortlist + scout-note state for the browsing club.
    if (meRole === "club" && !isOwner) {
      wireShortlist(!!(res && res.shortlisted));
      scoutNote = (res && res.myScoutNote) || null;
    }

    // Shareable / SEO meta: title, description and photo for social previews.
    setMeta("og:title", (p.name || "ملف رياضي") + " | Manara");
    setMeta("og:description", (p.bio || "ملف رياضي موثّق على منارة") + " — " + (p.sport || "رياضي"));
    setMeta("og:url", window.location.href);
    if (p.photo) setMeta("og:image", window.location.origin + p.photo);
    if (p && (p.slug || p.id)) setCanonical(window.location.origin + "/player/" + encodeURIComponent(p.slug || p.id));

    // avatar + verified badge (only registered athletes who passed review)
    var avatar = document.querySelector(".avatar");
    if (avatar) {
      if (p.photo) {
        avatar.innerHTML = '<img src="' + esc(p.photo) + '" alt="">';
      } else {
        var initials = (p.name || "A").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("");
        avatar.innerHTML = esc(initials);
      }
    }
    var isVerified = p.verified !== false;
    var vbadge = document.querySelector(".cover .verified");
    if (vbadge) {
      if (isVerified) { vbadge.textContent = "🪪 هوية موثقة · تم التحقق من المستندات"; vbadge.style.display = ""; }
      else vbadge.style.display = "none";
    }

    // name + handle
    var nameEl = document.querySelector(".name-block h1");
    if (nameEl) {
      nameEl.innerHTML = esc(p.name || "") + (isVerified ? ' <span class="check" title="معتمد"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>' : "");
    }
    var handle = p.handle || (p.email ? p.email.split("@")[0] : "") || "athlete";
    set(".handle", "@" + esc(handle.replace(/^@/, "")) + " · " + esc(p.sport || "") + (p.position ? " · " + esc(p.position) : ""));

    // tags
    var tags = document.querySelector(".tags");
    if (tags) {
      tags.innerHTML = "";
      function tag(txt, cls) {
        var s = document.createElement("span");
        s.className = "tag" + (cls ? " " + cls : "");
        s.textContent = txt;
        tags.appendChild(s);
      }
      if (p.sport) tag(ar(p.sport) + (p.position ? " · " + p.position : ""));
      if (p.level) tag(lvl(p.level), "green");
      tag(p.available === false ? "📄 مرتبط بعقد" : "🔥 متاح للانتقال", "orange");
      if (p.country) tag("🌍 " + p.country, "gray");
      if (p.currentClub) tag("🏟️ " + p.currentClub, "gray");
    }

    // quick stats (age / height / weight / foot / experience)
    var age = ageFromDob(p.dob);
    var exp = age != null ? Math.max(1, age - 16) + "y" : "—";
    var qvals = [
      { b: age != null ? age : (p.age || "—"), s: "سنة" },
      { b: p.height ? p.height + "cm" : "—", s: "الطول" },
      { b: p.weight ? p.weight + "kg" : "—", s: "الوزن" },
      { b: p.foot || "—", s: "القدم" },
      { b: exp, s: "خبرة" }
    ];
    var qs = document.querySelectorAll(".quick-stats .qs");
    for (var i = 0; i < qs.length && i < qvals.length; i++) {
      var q = qs[i].querySelector("b");
      var qs2 = qs[i].querySelector("span");
      if (q) q.textContent = String(qvals[i].b);
      if (qs2) qs2.textContent = qvals[i].s;
    }

    // bio
    var bio = document.querySelector(".bio");
    if (bio && p.bio) bio.textContent = p.bio;

    // videos — the real ones uploaded by the user
    renderVideos(p.videos, p.name);

    // quick info widget
    fillQuickInfo(p);

    // declaration image (صورة الإقرار) — owner only
    var declCard = document.getElementById("declCardWrap");
    if (!isOwner && declCard) declCard.style.display = "none";
    var decl = p.declaration || (p.documents && p.documents.declaration);
    var declImg = document.getElementById("declImg");
    var declLink = document.getElementById("declLink");
    var declEmpty = document.getElementById("declEmpty");
    if (declImg && declLink && declEmpty) {
      if (decl) {
        declImg.src = "";
        declLink.style.display = "block";
        declEmpty.style.display = "none";
        authedUrl(decl).then(function (blobUrl) {
          declImg.src = blobUrl;
          declLink.href = blobUrl;
        }).catch(function () {
          // The declaration EXISTS but failed to load (network/session issue) —
          // do not lie that it was never uploaded.
          declLink.style.display = "none";
          declEmpty.textContent = "⚠️ تعذر تحميل صورة الإقرار — أعد تحميل الصفحة";
          declEmpty.style.display = "block";
        });
      } else {
        declLink.style.display = "none";
        declEmpty.style.display = "block";
      }
    }

    // contact widget (masked for non-owners)
    fillContact(p, isOwner);

    // documents widget — visible to the owner and to clubs (clubs only ever
    // receive the medical report from the API, never other proof documents).
    if (!isOwner && meRole !== "club") {
      var docCard = document.getElementById("docCardWrap");
      if (docCard) docCard.style.display = "none";
    }
    fillDocuments(p);

    // trial / subscription banner for the account owner only
    if (isOwner) renderTrialBanner();

    // "من شاهد بروفايلك" — who viewed my profile (owner only)
    renderViewers(isOwner ? res.views : null);

    // club ratings / reviews widget (everyone sees the list; clubs can rate)
    renderReviews(res, p);
  }

  // Owner-only widget: list the clubs / users who viewed this profile.
  function renderViewers(views) {
    var box = document.getElementById("viewersBox");
    if (!box) return;
    var list = document.getElementById("viewersList");
    if (!views || !views.length) {
      box.style.display = "none";
      return;
    }
    var now = Date.now();
    var items = views.slice(0, 8).map(function (v) {
      var label = v.viewerClub || v.viewerName || "مستخدم";
      var roleTxt = v.viewerRole === "club" ? "🏟️ نادي" : (v.viewerRole === "player" ? "🥅 لاعب" : "👤 " + (v.viewerRole || ""));
      var t = v.at ? timeAgo(v.at, now) : "";
      var count = (v.count || 1) > 1 ? " · " + v.count + " زيارة" : "";
      return '<div class="info-row" style="padding:8px 2px;">' +
        '<b style="font-size:13px;">' + esc(label) + "</b>" +
        "<span style=\"font-size:11px;\">" + roleTxt + (t ? " · " + t : "") + count + "</span></div>";
    }).join("");
    list.innerHTML = items +
      (views.length > 8 ? '<div style="text-align:center;font-size:11px;color:var(--gray-500);font-weight:700;">و' + (views.length - 8) + " زائر آخر</div>" : "");
    box.style.display = "";
  }

  function timeAgo(iso, now) {
    try {
      var d = new Date(iso).getTime();
      if (!isFinite(d)) return "";
      var s = Math.floor((now - d) / 1000);
      if (s < 60) return "الآن";
      if (s < 3600) return "منذ " + Math.floor(s / 60) + " د";
      if (s < 86400) return "منذ " + Math.floor(s / 3600) + " س";
      if (s < 86400 * 30) return "منذ " + Math.floor(s / 86400) + " يوم";
      return new Date(iso).toLocaleDateString("ar-EG");
    } catch (e) { return ""; }
  }

  function starRow(n) {
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= Math.round(n) ? "★" : "☆";
    return s;
  }

  function renderReviews(res, p) {
    var box = document.getElementById("reviewCard");
    if (!box) return;
    var reviews = (res && res.reviews) || [];
    var myReview = (res && res.myReview) || null;
    var rating = p.rating || 0;
    var html =
      '<div class="card-title"><span><span class="ico">⭐</span> تقييم الأندية</span></div>';
    if (rating > 0) {
      html +=
        '<div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;">' +
        '<span style="font-size:32px;font-weight:900;color:var(--dark);">' + rating.toFixed(1) + "</span>" +
        '<div><div class="stars" style="font-size:16px;">' + starRow(rating) + "</div>" +
        '<span style="font-size:12px;color:var(--gray-500);font-weight:600;">' + (p.reviews || 0) + " تقييم من الأندية</span></div></div>";
    } else {
      html += '<p style="color:var(--gray-500);font-weight:600;font-size:13px;margin:0 0 12px;">لا توجد تقييمات بعد — الأندية تقيّم اللاعب بعد التعامل معه.</p>';
    }

    // Rate widget — only club accounts browsing another player.
    if (meRole === "club" && viewedPlayer && !viewedPlayer.isOwner) {
      var myStars = myReview ? myReview.stars : 0;
      html +=
        '<div style="border:1.5px dashed var(--gray-300);border-radius:12px;padding:12px 14px;margin-bottom:14px;">' +
        '<div style="font-weight:900;font-size:13px;color:var(--dark);margin-bottom:8px;">' + (myReview ? "تقييمك الحالي لهذا اللاعب" : "قيّم هذا اللاعب") + "</div>" +
        '<div class="rate-stars" style="display:flex;gap:4px;font-size:24px;margin-bottom:8px;">' +
        [1, 2, 3, 4, 5].map(function (n) {
          return '<button type="button" data-star="' + n + '" style="background:none;border:none;cursor:pointer;font-size:24px;line-height:1;padding:2px;color:' + (n <= myStars ? "#fbbf24" : "var(--gray-300)") + ';" aria-label="' + n + ' نجوم">★</button>';
        }).join("") +
        '</div>' +
        '<textarea id="rateComment" rows="2" placeholder="اكتب ملاحظة قصيرة (اختياري)…" style="width:100%;border:1.5px solid var(--gray-200);border-radius:10px;padding:9px 11px;font-family:inherit;font-size:13px;font-weight:600;background:var(--surface);color:var(--dark);resize:vertical;margin-bottom:8px;box-sizing:border-box;"></textarea>' +
        '<button type="button" id="rateSubmit" style="border:none;border-radius:10px;padding:9px 16px;font-family:inherit;font-weight:900;font-size:13px;cursor:pointer;background:var(--primary);color:#fff;">' + (myReview ? "تحديث التقييم" : "إرسال التقييم") + "</button></div>" +
        // Private scout note — only the writing club ever sees it.
        '<div style="border:1.5px dashed var(--gray-300);border-radius:12px;padding:12px 14px;margin-bottom:14px;">' +
        '<div style="font-weight:900;font-size:13px;color:var(--dark);margin-bottom:6px;">🕵️ ملاحظة سكاوت خاصة (لا يراها اللاعب)</div>' +
        '<textarea id="scoutNoteBox" rows="2" placeholder="مثال: سرعة ممتازة، يحتاج تحسين التمركز الدفاعي…" style="width:100%;border:1.5px solid var(--gray-200);border-radius:10px;padding:9px 11px;font-family:inherit;font-size:13px;font-weight:600;background:var(--surface);color:var(--dark);resize:vertical;margin-bottom:8px;box-sizing:border-box;"></textarea>' +
        '<button type="button" id="scoutNoteSave" style="border:none;border-radius:10px;padding:9px 16px;font-family:inherit;font-weight:900;font-size:13px;cursor:pointer;background:#0f172a;color:#fff;">حفظ الملاحظة</button>' +
        '<button type="button" id="scoutNoteClear" style="border:1.5px solid var(--gray-300);border-radius:10px;padding:8px 14px;font-family:inherit;font-weight:900;font-size:13px;cursor:pointer;background:none;color:var(--gray-500);margin-inline-start:8px;">حذف</button></div>';
    }

    if (reviews.length) {
      html += reviews.map(function (r) {
        return '<div style="border-top:1px solid var(--gray-100);padding:12px 2px;">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-size:12.5px;font-weight:900;color:var(--dark);">' + esc(r.clubName || "نادي") + "</span>" +
          '<span class="stars" style="font-size:13px;">' + starRow(r.stars) + "</span>" +
          '<span style="font-size:11px;color:var(--gray-400);font-weight:600;">' + (r.createdAt ? new Date(r.createdAt).toLocaleDateString("ar-EG") : "") + "</span></div>" +
          (r.comment ? '<p style="margin:6px 0 0;font-size:13px;color:var(--gray-600);font-weight:600;line-height:1.7;">' + esc(r.comment) + "</p>" : "") +
          "</div>";
      }).join("");
    }
    box.innerHTML = html;
    box.style.display = "";

    // wire the star picker + submit
    var stars = box.querySelectorAll(".rate-stars button");
    var chosen = myStars;
    var comment = box.querySelector("#rateComment");
    if (comment && myReview) comment.value = myReview.comment || "";
    stars.forEach(function (btn) {
      btn.addEventListener("click", function () {
        chosen = parseInt(btn.getAttribute("data-star"), 10);
        stars.forEach(function (b) {
          var n = parseInt(b.getAttribute("data-star"), 10);
          b.style.color = n <= chosen ? "#fbbf24" : "var(--gray-300)";
        });
      });
    });
    var submit = box.querySelector("#rateSubmit");
    if (submit) {
      submit.addEventListener("click", function () {
        if (!chosen) { toast("اختر عدد النجوم أولاً", true); return; }
        submit.disabled = true;
        window.API.ratePlayer(viewedPlayer.id, {
          stars: chosen,
          comment: comment ? comment.value : ""
        }).then(function (r) {
          toast(myReview ? "✅ تم تحديث تقييمك" : "✅ تم إرسال تقييمك");
          return window.API.getPlayer(viewedPlayer.id).then(function (res2) {
            renderReviews(res2, res2.player);
          });
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر إرسال التقييم"), true);
        }).finally(function () { submit.disabled = false; });
      });
    }

    // Private scout note save / clear.
    var scoutBox = box.querySelector("#scoutNoteBox");
    if (scoutBox && scoutNote) scoutBox.value = scoutNote;
    var scoutSave = box.querySelector("#scoutNoteSave");
    if (scoutSave) {
      scoutSave.addEventListener("click", function () {
        scoutSave.disabled = true;
        var text = scoutBox.value.trim();
        window.API.scoutNote(viewedPlayer.id, text).then(function () {
          scoutNote = text || null;
          toast(text ? "✅ حُفظت الملاحظة الخاصة" : "تم حذف الملاحظة");
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر حفظ الملاحظة"), true);
        }).finally(function () { scoutSave.disabled = false; });
      });
    }
    var scoutClear = box.querySelector("#scoutNoteClear");
    if (scoutClear) {
      scoutClear.addEventListener("click", function () {
        scoutBox.value = "";
        if (scoutSave) scoutSave.click();
      });
    }
  }

  function renderTrialBanner() {
    var el = document.getElementById("trialBanner");
    if (!el || !window.API) return;
    window.API.subscriptionStatus().then(function (st) {
      // In-app notification toast (milestones + expiry reminders + payment results).
      if (st.notifications && st.notifications.length) {
        var last = st.notifications[st.notifications.length - 1];
        toast((last.title || "") + " — " + (last.message || ""));
      }
      var html = "";
      if (window.SubBanner) {
        // SubBanner verifies the REAL paid/pending status before showing any
        // "subscribe now" prompt (a paid user must never see the trial CTA).
        window.SubBanner.render(el, st);
        return;
      }
      if (st.status === "trialing" && st.trial && !st.trial.expired) {
        var days = Math.max(0, st.trial.daysLeft);
        var ttl = st.trial.days || null;
        var ttlLabel = ttl == null ? "" : (ttl === 1 ? " (يوم واحد)" : ttl === 2 ? " (يومان)" : " (" + ttl + " أيام)");
        html =
          '<div style="display:flex;gap:12px;align-items:center;background:linear-gradient(135deg,var(--primary-light),var(--green-bg));border:1px solid var(--primary);border-radius:14px;padding:12px 16px;margin-bottom:18px;">' +
          '<span style="font-size:24px;">🎁</span>' +
          '<div style="flex:1;">' +
          '<div style="font-weight:900;color:var(--dark);font-size:14px;">تجربتك المجانية' + ttlLabel + ' — <span style="background:var(--primary);color:#fff;border-radius:20px;padding:2px 10px;font-size:12px;">' + days + ' يوم متبقٍ</span></div>' +
          '<div style="color:var(--gray-600);font-weight:600;font-size:12.5px;margin-top:3px;line-height:1.7;">تنتهي في ' + new Date(st.trial.end).toLocaleDateString("ar-EG") + ' — يمكنك الترقية الآن أو بعد انتهاء التجربة. <a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">إدارة الاشتراك ←</a></div>' +
          "</div></div>";
      } else if (st.status === "expired") {
        html =
          '<div style="display:flex;gap:12px;align-items:center;background:var(--gray-100);border:1px solid var(--orange);border-radius:14px;padding:12px 16px;margin-bottom:18px;">' +
          '<span style="font-size:24px;">⏰</span>' +
          '<div style="flex:1;">' +
          '<div style="font-weight:900;color:var(--dark);font-size:14px;">انتهت فترة وصولك</div>' +
          '<div style="color:var(--gray-600);font-weight:600;font-size:12.5px;margin-top:3px;line-height:1.7;">اشترك شهرياً (' + st.price + ' ج.م/شهر) لمواصلة المزايا المميزة. <a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">اشترك الآن ←</a></div>' +
          "</div></div>";
      }
      el.innerHTML = html;
      el.style.display = html ? "" : "none";
    }).catch(function () {});
  }

  function renderVideos(videos, name) {
    var grid = document.querySelector(".video-grid");
    if (!grid) return;
    var link = document.querySelector(".card-title a");
    var list = (videos || []).filter(function (v) { return v && (v.url || v.secureUrl); });
    if (!list.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--gray-500);font-weight:700;padding:28px 10px;">🎥 لم يقم ' + esc(name || "هذا الرياضي") + ' برفع فيديوهات بعد</div>';
      if (link) link.style.display = "none";
      return;
    }
    if (link) link.textContent = "عرض الكل (" + list.length + ") ←";
    if (link) link.href = list[0].url || list[0].secureUrl;
    grid.innerHTML = list.map(function (v) {
      var src = v.url || v.secureUrl;
      // Auto-generated poster: <video>.jpg next to the video (FFmpeg frame).
      var poster = String(src).replace(/\.(mp4|mov|mkv|3gp|3g2|m4v|webm|ogv)$/i, ".jpg");
      return '<div class="v-card">' +
        '<video class="thumb" controls preload="metadata" src="' + esc(src) + '" poster="' + esc(poster) + '" style="background:#0f172a" onerror="if(this.hasAttribute(\'poster\'))this.removeAttribute(\'poster\');"></video>' +
        (v.duration ? '<span class="duration">' + fmtDur(v.duration) + "</span>" : "") +
        '<span class="v-label" title="' + esc(v.name || "") + '">' + esc((v.name || "فيديو").slice(0, 22)) + "</span>" +
        "</div>";
    }).join("");
  }

  function fillQuickInfo(p) {
    var box = document.getElementById("quickInfo");
    if (!box) return;
    var rows = [];
    function row(k, v) {
      if (v == null || v === "") return;
      rows.push('<div class="info-row"><b>' + esc(k) + "</b><span>" + esc(v) + "</span></div>");
    }
    var dob = p.dob ? p.dob.split("-").reverse().join(" / ") : "";
    row("تاريخ الميلاد", dob);
    row("الجنسية", p.country);
    row("الرياضة", p.sport ? ar(p.sport) : "");
    row("المركز", p.position);
    row("القدم", p.foot);
    row("الطول / الوزن", (p.height ? p.height : "—") + " / " + (p.weight ? p.weight : "—"));
    row("النادي الحالي", p.currentClub);
    row("المستوى", p.level ? lvl(p.level) : "");
    if (p.userId) {
      rows.push('<div class="info-row"><b>التحقق من الهوية</b><span style="color:var(--green);font-weight:800;">✅ موثقة — تمت مراجعة صورة الإقرار</span></div>');
    }
    box.innerHTML = rows.length
      ? rows.join("")
      : '<div style="color:var(--gray-500);font-size:12.5px;text-align:center;padding:6px;">لا توجد بيانات إضافية</div>';
  }

  function fillContact(p, isOwner) {
    var box = document.getElementById("contactBox");
    if (!box) return;
    var rows = [];
    function row(ico, label, val) {
      if (val == null || val === "") return;
      rows.push('<div class="contact-row"><div class="ci">' + ico + '</div><div style="flex:1"><b>' + esc(label) + "</b><span>" + esc(val) + "</span></div></div>");
    }
    row("📞", "الهاتف", p.phone);
    row("✉️", "البريد", p.email);
    row("💬", "واتساب", p.whatsapp);
    var socials = "";
    if (isOwner) {
      socials = p.instagram
        ? '<div class="socials-row"><a class="social-pill" target="_blank" rel="noopener" href="https://instagram.com/' + esc(p.instagram.replace(/^@/, "")) + '" title="Instagram">📷</a></div>'
        : "";
    } else {
      row("📷", "انستغرام", p.instagram);
    }
    var lock = !isOwner
      ? '<div style="margin-top:10px;padding:8px 10px;border:1px dashed var(--gray-300);border-radius:10px;color:var(--gray-500);font-size:12px;font-weight:700;text-align:center;">🔒 أُخفي جزء من بيانات التواصل لحماية الخصوصية — للتواصل مع اللاعب تواصل عبر المنصة</div>'
      : "";
    box.innerHTML = (rows.length ? rows.join("") : '<div style="color:var(--gray-500);font-size:12.5px;text-align:center;padding:6px;">لا توجد بيانات تواصل</div>') + socials + lock;
  }

  function fillDocuments(p) {
    var box = document.querySelector(".doc-list");
    if (!box) return;
    var docs = p.documents || {};
    var map = {
      birth_cert: ["شهادة الميلاد", "📄"],
      medical: ["التقرير الطبي", "🏥"],
      official_letter: ["الخطاب الرسمي", "📋"],
      license: ["رخصة النادي", "🪪"]
    };
    var rows = [];
    Object.keys(docs).forEach(function (k) {
      var url = docs[k];
      if (!url) return;
      var m = map[k] || [k, "📄"];
      rows.push('<div class="doc"><div class="dico">' + m[1] + '</div><div class="dinfo"><b>' + esc(m[0]) + '</b><span>ملف مرفق</span></div><a class="view" href="' + esc(url) + '" target="_blank" rel="noopener">عرض</a></div>');
    });
    box.innerHTML = rows.length
      ? rows.join("")
      : '<div style="color:var(--gray-500);font-size:12.5px;text-align:center;padding:6px;">لم يتم رفع مستندات بعد</div>';
  }

  // Clubs can start a conversation with a player they are browsing.
  function ensureMessageBtn() {
    var btn = document.getElementById("msgBtn");
    if (!btn || btn._wired) return;
    if (!viewedPlayer || viewedPlayer.isOwner || meRole !== "club") return;
    btn._wired = true;
    btn.style.display = "inline-flex";
    btn.addEventListener("click", function () {
      window.location.href = "messages.html?player=" + encodeURIComponent(viewedPlayer.id);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();