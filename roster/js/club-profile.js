(function () {
  "use strict";

  // Club profiles are private: signed-out visitors go to the login page.
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

  function setMeta(prop, content) {
    var el = document.querySelector('meta[property="' + prop + '"]');
    if (el && content) el.setAttribute("content", content);
  }

  function setCanonical(href) {
    var el = document.querySelector('link[rel="canonical"]');
    if (!el) { el = document.createElement("link"); el.rel = "canonical"; document.head.appendChild(el); }
    el.setAttribute("href", href);
  }

  function starRow(n) {
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= Math.round(n) ? "★" : "☆";
    return s;
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

  function showMessage(emoji, title, msg, link) {
    var c = document.querySelector(".container");
    if (!c) return;
    c.innerHTML =
      '<div style="max-width:560px;margin:60px auto;padding:40px 24px;text-align:center;background:var(--surface);border:1px solid var(--gray-200);border-radius:16px;box-shadow:var(--shadow-md);">' +
      '<div style="font-size:44px;margin-bottom:10px;">' + emoji + "</div>" +
      "<h2 style=\"font-family:Inter,sans-serif;font-size:20px;font-weight:900;color:var(--dark);\">" + title + "</h2>" +
      '<p style="color:var(--gray-500);font-weight:600;margin:10px 0 22px;line-height:1.7;">' + msg + "</p>" +
      link +
      "</div>";
  }

  function init() {
    initAuthNav();

    // A club opened from the board: club-profile.html?club=<slug|id>
    // (owner sees the full profile; any other account sees a masked copy).
    var clubParam = (new URLSearchParams(window.location.search).get("club") || "").trim();
    if (clubParam) {
      window.API.getClub(clubParam).then(function (res) {
        var club = res && (res.club || res.data);
        if (!club) {
          showMessage("🏟️", "النادي غير موجود", "لم يتم العثور على ملف النادي المطلوب.", '<a href="clubs.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🏟️ تصفح الأندية</a>');
          return;
        }
        render(club, !!(res && res.owner));
      }).catch(function (err) {
        if (err && err.status === 401) {
          if (window.API && window.API.logout) window.API.logout();
          window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
          return;
        }
        showMessage("🚫", "تعذر فتح الملف", "حدث خطأ أثناء تحميل ملف النادي — حاول مرة أخرى.", '<a href="clubs.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🏟️ تصفح الأندية</a>');
      });
      return;
    }

    window.API.getMe().then(function (me) {
      if (!me || !me.user) {
        if (window.API && window.API.logout) window.API.logout();
        window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      var own = me && me.profile;
      var role = me && me.user && me.user.role;
      if (role === "admin") {
        showMessage("🛡️", "هذا حساب إداري", "حساب الأدمن لا يملك ملف نادٍ. استخدم لوحة الإدارة لمراجعة طلبات التسجيل.", '<a href="admin.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🛡️ فتح لوحة الإدارة</a>');
        return;
      }
      if (!own) { showMessage("🏟️", "لا يوجد ملف", "ليس لديك ملف نادٍ مرتبط بهذا الحساب.", '<a href="Sign/Sign_Up.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🏟️ أنشئ ملف النادي</a>'); return; }
      if (own.id.indexOf("c_") === 0) {
        render(own, true);
      } else if (own.id.indexOf("p_") === 0) {
        window.location.replace("profile.html?player=" + encodeURIComponent(own.slug || own.id));
      } else {
        showMessage("🏟️", "لا يوجد ملف", "ليس لديك ملف نادٍ مرتبط بهذا الحساب.", '<a href="Sign/Sign_Up.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🏟️ أنشئ ملف النادي</a>');
      }
    }).catch(function (err) {
      if (err && err.status === 403) {
        showMessage("🚫", "لا يمكنك عرض هذا البروفايل", "هذا الملف يعود لحساب آخر ولا يمكنك الوصول إليه.", '<a href="club-profile.html" style="display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none;background:var(--primary);color:#fff;">🏟️ ملف النادي</a>');
        return;
      }
      // Invalid / expired session: never fall back to the static demo
      // profile — clear the stale token and ask the visitor to sign in.
      if (window.API && window.API.logout) window.API.logout();
      window.location.href = "Sign/Sign_In.html?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
    });
  }

  // Shortlist: the club's saved players + side-by-side comparison table.
  function playerAge(p) {
    if (p.age != null) return p.age;
    if (!p.dob) return "—";
    var d = new Date(p.dob);
    if (isNaN(d.getTime())) return "—";
    var now = new Date();
    var a = now.getFullYear() - d.getFullYear();
    if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
    return Math.max(0, a);
  }

  function renderShortlist(list) {
    var box = document.getElementById("shortlistBox");
    var compare = document.getElementById("compareBtn");
    if (!box) return;
    var players = (list || []).filter(function (p) { return p && p.id; });
    if (!players.length) {
      box.innerHTML = '<div style="color:var(--gray-500);font-weight:700;padding:8px 0;">⭐ لا يوجد لاعبون في القائمة المختصرة بعد — من ملف اللاعب اضغط «قائمة مختصرة».</div>';
      if (compare) compare.style.display = "none";
      return;
    }
    if (compare) compare.style.display = "inline-flex";
    box.innerHTML = players.map(function (p) {
      var stars = p.rating > 0
        ? '<span class="stars" style="font-size:12px;color:#fbbf24;">' + starRow(p.rating) + '</span>'
        : '<span style="font-size:11px;color:var(--gray-400);font-weight:600;">لا تقييم بعد</span>';
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--gray-50,#f8fafc);border:1px solid var(--gray-100,#eef2f7);border-radius:12px;">' +
        '<div style="width:38px;height:38px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;">' + esc((p.name || "P").charAt(0).toUpperCase()) + "</div>" +
        '<div style="flex:1"><b>' + esc(p.name || "لاعب") + "</b>" + (p.position ? '<span style="display:block;color:var(--gray-500);font-size:12.5px;font-weight:600;">' + esc(p.position) + " · " + esc(p.sport || "") + "</span>" : "") + '<span style="display:block;">' + stars + "</span></div>" +
              '<a href="/player/' + esc(p.slug || p.id) + '" class="view" style="text-decoration:none;font-weight:700;">عرض</a>' +
        "</div>";
    }).join("");

    // Compare button -> side-by-side stats table.
    var compareBox = document.getElementById("compareBox");
    if (compare && compareBox) {
      compare.addEventListener("click", function () {
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
        var head = '<tr><th style="padding:8px;text-align:start;color:var(--gray-500);font-size:12px;white-space:nowrap;">المعيار</th>' +
          players.map(function (p) { return '<th style="padding:8px;text-align:start;font-size:12.5px;white-space:nowrap;">' + esc(p.name || "لاعب") + "</th>"; }).join("") + "</tr>";
        var body = rows.map(function (r) {
          return '<tr><td style="padding:8px;font-weight:800;font-size:12.5px;white-space:nowrap;color:var(--gray-600);">' + r[0] + "</td>" +
            players.map(function (p) {
              var v = r[1](p);
              return '<td style="padding:8px;font-size:12.5px;white-space:nowrap;">' + esc(v == null ? "—" : v) + "</td>";
            }).join("") + "</tr>";
        }).join("");
        compareBox.innerHTML =
          '<div style="font-weight:900;font-size:13px;margin-bottom:8px;">⚖️ مقارنة اللاعبين (' + players.length + ")</div>" +
          '<table style="width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--gray-100);border-radius:12px;overflow:hidden;">' +
          '<thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
        compareBox.style.display = compareBox.style.display === "none" ? "" : "none";
      });
    }
  }

  function render(club, isOwner) {
    document.title = (club.name || "ملف النادي") + " | Manara";

    // Non-owners see the public club card only: the club's private scouting
    // list and official documents stay with the owner.
    if (!isOwner) {
      var sc = document.getElementById("shortlistCard");
      if (sc) sc.style.display = "none";
      var dc = document.getElementById("docsCard");
      if (dc) dc.style.display = "none";
    }

    // Shareable / SEO meta for the club detail page.
    setMeta("og:title", (club.name || "ملف النادي") + " | Manara");
    setMeta("og:description", (club.description || "نادي موثّق على منارة — يتعاقد مع الرياضيين") + " · " + (club.sport || "رياضة"));
    setMeta("og:url", window.location.href);
    if (club.logo) setMeta("og:image", window.location.origin + club.logo);
    if (club && (club.slug || club.id)) setCanonical(window.location.origin + "/club/" + encodeURIComponent(club.slug || club.id));

    var isVerified = club.verified !== false;
    var nameEl = document.getElementById("clubName");
    if (nameEl) nameEl.innerHTML = esc(club.name || "نادي") + (isVerified ? ' <span class="check" title="معتمد"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>' : "");

    var idEl = document.getElementById("clubId");
    if (idEl) idEl.textContent = club.id + " · " + (club.type || "نادي") + (club.city ? " · " + club.city : "");

    var badge = document.getElementById("coverBadge");
    if (badge) badge.style.display = isVerified ? "" : "none";

    var logoBox = document.getElementById("clubLogo");
    if (logoBox) {
      logoBox.innerHTML = club.logo
        ? '<img src="' + esc(club.logo) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">'
        : "🏟️";
    }

    var tags = document.getElementById("clubTags");
    if (tags) {
      var t = [];
      if (club.type) t.push('<span class="tag">🏟️ ' + esc(club.type) + "</span>");
      if (club.sport) t.push('<span class="tag green">⚡ ' + esc(sportAr(club.sport)) + "</span>");
      if (club.country) t.push('<span class="tag gray">🌍 ' + esc(club.country) + "</span>");
      if (club.city) t.push('<span class="tag gray">📍 ' + esc(club.city) + "</span>");
      tags.innerHTML = t.join("");
    }

    // quick stats
    var qs = document.querySelectorAll("#clubStats .qs b");
    var qv = [
      club.founded || "—",
      (club.league || "—").slice(0, 12),
      "—",
      club.neededPosition || "—"
    ];
    for (var i = 0; i < qs.length && i < qv.length; i++) qs[i].textContent = String(qv[i]);

    // about
    var about = document.getElementById("clubAbout");
    if (about) {
      var lines = [];
      if (club.league) lines.push("🏆 " + esc(club.league));
      if (club.type) lines.push("🏟️ " + esc(club.type));
      if (club.country && club.city) lines.push("📍 " + esc(club.city) + "، " + esc(club.country));
      else if (club.country) lines.push("📍 " + esc(club.country));
      if (club.founded) lines.push("📅 تأسس عام " + club.founded);
      if (club.website) lines.push("🌐 " + esc(club.website));
      about.textContent = lines.length ? lines.join(" · ") : "لم تتم إضافة تفاصيل عن النادي بعد.";
    }

    // needed positions
    var needs = document.getElementById("clubNeeds");
    if (needs) {
      if (club.neededPosition) {
        needs.innerHTML = "🔍 يبحث النادي حاليًا عن: <b>" + esc(club.neededPosition) + "</b>";
      } else {
        needs.textContent = "لم يحدد النادي المركز المطلوب حاليًا.";
      }
    }

    // squad (players registered under this club's name)
    window.API.getClub(club.id).then(function (res) {
      var squad = (res && res.squad) || [];
      var box = document.getElementById("clubSquad");
      if (box) {
        if (!squad.length) {
          box.innerHTML = '<div style="color:var(--gray-500);font-weight:700;padding:8px 0;">👥 لا يوجد لاعبون مسجلون تحت هذا النادي بعد.</div>';
        } else {
          box.innerHTML = squad.map(function (p) {
            var stars = p.rating > 0
              ? '<span class="stars" style="font-size:12px;color:#fbbf24;">' + starRow(p.rating) + '</span>'
              : '<span style="font-size:11px;color:var(--gray-400);font-weight:600;">لا تقييم بعد</span>';
            return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--gray-50,#f8fafc);border:1px solid var(--gray-100,#eef2f7);border-radius:12px;">' +
              '<div style="width:38px;height:38px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;">' + esc((p.name || "P").charAt(0).toUpperCase()) + "</div>" +
              '<div style="flex:1"><b>' + esc(p.name || "لاعب") + "</b>" + (p.position ? '<span style="display:block;color:var(--gray-500);font-size:12.5px;font-weight:600;">' + esc(p.position) + "</span>" : "") + '<span style="display:block;">' + stars + "</span></div>" +
        '<a href="/player/' + esc(p.slug || p.id) + '" class="view" style="text-decoration:none;font-weight:700;">عرض</a>' +
              "</div>";
          }).join("");
        }
      }
      if (isOwner) {
        renderShortlist(res && res.shortlist);
      }
    }).catch(function () {});

    // documents
    var docs = club.documents || {};
    var map = { official_letter: ["الخطاب الرسمي", "📜"], license: ["رخصة النادي / السجل التجاري", "🏛️"] };
    var docBox = document.getElementById("clubDocs");
    if (docBox) {
      var rows = [];
      Object.keys(docs).forEach(function (k) {
        var url = docs[k];
        if (!url) return;
        var m = map[k] || [k, "📄"];
        rows.push('<div class="doc"><div class="dico">' + m[1] + '</div><div class="dinfo"><b>' + esc(m[0]) + "</b><span>ملف مرفق</span></div><a class=\"view\" href=\"" + esc(url) + '" target="_blank" rel="noopener">عرض</a></div>');
      });
      docBox.innerHTML = rows.length ? rows.join("") : '<div style="color:var(--gray-500);font-size:12.5px;text-align:center;padding:6px;">لم يتم رفع مستندات بعد</div>';
    }

    // quick info
    var quick = document.getElementById("clubQuick");
    if (quick) {
      var qrows = [];
      function qrow(k, v) { if (v != null && v !== "") qrows.push('<div class="info-row"><b>' + esc(k) + "</b><span>" + esc(v) + "</span></div>"); }
      qrow("سنة التأسيس", club.founded);
      qrow("الدوري / المسابقة", club.league);
      qrow("نوع النادي", club.type);
      qrow("الدولة", club.country);
      qrow("المدينة", club.city);
      qrow("اسم المسؤول", club.contactName);
      qrow("المنصب", club.contactRole);
      qrow("المركز المطلوب", club.neededPosition);
      quick.innerHTML = qrows.length ? qrows.join("") : '<div style="color:var(--gray-500);font-size:12.5px;text-align:center;padding:6px;">لا توجد بيانات إضافية</div>';
    }

    // contact
    var contact = document.getElementById("clubContact");
    if (contact) {
      var crows = [];
      function crow(ico, label, val) { if (val != null && val !== "") crows.push('<div class="contact-row"><div class="ci">' + ico + '</div><div style="flex:1"><b>' + esc(label) + "</b><span>" + esc(val) + "</span></div></div>"); }
      crow("📞", "رقم التواصل", club.phone);
      crow("✉️", "البريد الرسمي", club.email);
      crow("💬", "واتساب", club.whatsapp);
      crow("🌐", "الموقع", club.website);
      contact.innerHTML = crows.length ? crows.join("") : '<div style="color:var(--gray-500);font-size:12.5px;text-align:center;padding:6px;">لا توجد بيانات تواصل</div>';
    }

    renderTrialBanner();
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
          '<div style="font-weight:900;color:var(--dark);font-size:14px;">تجربة النادي المجانية' + ttlLabel + ' — <span style="background:var(--primary);color:#fff;border-radius:20px;padding:2px 10px;font-size:12px;">' + days + ' يوم متبقٍ</span></div>' +
          '<div style="color:var(--gray-600);font-weight:600;font-size:12.5px;margin-top:3px;line-height:1.7;">تنتهي في ' + new Date(st.trial.end).toLocaleDateString("ar-EG") + ' — بعدها يتحول النادي للاشتراك الشهري. <a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">إدارة الاشتراك ←</a></div>' +
          "</div></div>";
      } else if (st.status === "expired") {
        html =
          '<div style="display:flex;gap:12px;align-items:center;background:var(--gray-100);border:1px solid var(--orange);border-radius:14px;padding:12px 16px;margin-bottom:18px;">' +
          '<span style="font-size:24px;">⏰</span>' +
          '<div style="flex:1;">' +
          '<div style="font-weight:900;color:var(--dark);font-size:14px;">انتهت فترة وصول النادي</div>' +
          '<div style="color:var(--gray-600);font-weight:600;font-size:12.5px;margin-top:3px;line-height:1.7;">اشترك شهرياً (' + st.price + ' ج.م/شهر) لمواصلة استقبال وإرسال الرسائل. <a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">اشترك الآن ←</a></div>' +
          "</div></div>";
      }
      el.innerHTML = html;
      el.style.display = html ? "" : "none";
    }).catch(function () {});
  }

  init();
})();