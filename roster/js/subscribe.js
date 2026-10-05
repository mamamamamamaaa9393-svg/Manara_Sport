/* ==========================================================================
   Manara — subscription page (real backend integration).
   Auth-check -> status check -> Gamer: free first message, locked AI reply
   (blurred preview) -> submit payment proof (Egyptian wallet: Vodafone Cash /
   Fawry + screenshot) -> admin manually reviews -> approval reveals reply +
   extends subscription. Club: payment required before sending. Payment
   receipts are screened for editing/tampering at upload time (rejected
   immediately if any sign of manipulation is detected).
   ========================================================================== */
(function () {
  "use strict";

  var state = {
    mode: "gamer",
    method: "fawry",
    realType: "gamer",
    price: 39,
    screenshotUrl: "",
    payCardEl: null,
    lockedPreview: null,
    lockedChatId: null
  };

  var FEATS_GAMER = [
    "فتح ردّك الحالي والردود القادمة بلا حدود",
    "نصائح مخصصة عن الأندية والمراكز والرواتب",
    "أول رد مجاني كتجربة — ولو ما عجبك، استرداد خلال 7 أيام",
    "إلغاء في أي وقت بضغطة واحدة"
  ];
  var FEATS_CLUB = [
    "استقبال أول رسالة فور التفعيل — تفعيل فوري",
    "ملفات لاعبين معتمدة بالشهادات والوثائق الطبية",
    "فيديوهات إنجازات + إحصائيات لكل لاعب",
    "أدوات تقييم ومقارنة داخل الملف",
    "تواصل مباشر ومنظم — بدون وسطاء"
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.style.background = isErr ? "#ef4444" : "";
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove("show"); }, 3800);
  }

  function $(id) { return document.getElementById(id); }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString("ar-EG"); } catch (e) { return "—"; }
  }

  function showOnly(id) {
    ["gamerView", "clubView", "pendingView", "activeView"].forEach(function (v) {
      $(v).style.display = v === id ? "" : "none";
    });
  }

  /* ------------------------------------------------------ auth + init */
  function setAuthNav(user) {
    var nameEl = $("authUserName");
    if (nameEl && user && user.name) nameEl.textContent = "👤 " + user.name;
    var sl = $("navShortlist");
    if (sl) sl.style.display = (user && user.role === "club") ? "" : "none";
    var lo = $("logoutBtn");
    if (lo) lo.addEventListener("click", function () {
      window.API.logout();
      window.location.href = "Sign/Sign_In.html";
    });
  }

  function setMode(mode) {
    state.mode = mode;
    $("gamerView").style.display = mode === "gamer" ? "" : "none";
    $("clubView").style.display = mode === "club" ? "" : "none";
    document.querySelectorAll(".mode-pill").forEach(function (p) {
      p.classList.toggle("active", p.dataset.mode === mode);
    });
    if (window.scrollY > 60) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ------------------------------------------------------ payment card */
  function mountPayCard() {
    var wrap = $("payCardWrap");
    var anchor = state.mode === "club" ? $("clubPayAnchor") : $("gamerPayAnchor");
    anchor.innerHTML = "";
    anchor.appendChild(wrap.firstElementChild || wrap);
    state.payCardEl = wrap.firstElementChild || null;
  }

  function resetPayCard() {
    state.method = "fawry";
    state.screenshotUrl = "";
    $("payAmount").value = String(state.price != null ? state.price : 39);
    $("payRef").value = "";
    $("payFile").value = "";
    $("payFileBtn").classList.remove("ready");
    $("payFileBtn").textContent = "📎 اضغط لرفع صورة الإيصال";
    document.querySelectorAll(".pay-chip").forEach(function (c) {
      c.classList.toggle("active", c.dataset.method === state.method);
    });
  }

  function showPayCard(type, price) {
    state.realType = type;
    state.price = price;
    var isClub = type === "club";
    $("payFlag").textContent = isClub ? "🏟️ خطة النادي" : "🎮 خطة اللاعب";
    $("payTitle").textContent = isClub ? "بوابة التواصل والانتقالات" : "الوصول الكامل للمساعد الذكي";
    $("payNum").textContent = price;
    $("payFeats").innerHTML = (isClub ? FEATS_CLUB : FEATS_GAMER)
      .map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("");
    resetPayCard();
    mountPayCard();
    // scroll the card into view on first mount
    var card = state.payCardEl;
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ------------------------------------------------------ chat (gamer) */
  function appendBubble(kind, html) {
    var box = $("chatArea");
    var d = document.createElement("div");
    d.className = "bubble " + kind;
    d.innerHTML = html;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function showLocked(preview, price) {
    var vis = esc(preview || "");
    var rest = '<p class="blurred">' + vis + "</p><p class=\"blurred\">الخطوة التالية أقترحها بعد الفتح الكامل…</p>";
    appendBubble("ai",
      '<span class="who">🤖 المساعد الذكي</span><div class="blur-wrap"><span class="visible">' + vis + "</span>" + rest + "</div>");
    showPayCard("gamer", price);
  }

  function sendChat() {
    var input = $("chatInput");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    var btn = $("sendChatBtn");
    btn.disabled = true;
    appendBubble("me", esc(text));

    window.API.subscriptionChat(text).then(function (res) {
      if (res.locked) {
        showLocked(res.preview || "", res.price || state.price);
      } else if (res.chat && res.chat.is_revealed) {
        appendBubble("ai", '<span class="who">🤖 المساعد الذكي</span>' + esc(res.chat.ai_response || ""));
      } else {
        appendBubble("ai", '<span class="who">🤖 المساعد الذكي</span>تم استلام رسالتك.');
      }
    }).catch(function (err) {
      // 402 -> a previous reply is still locked; show it + the pay card.
      if (err.status === 402) {
        state.lockedPreview = (err.data && err.data.preview) || "";
        state.lockedChatId = (err.data && err.data.chatId) || null;
        showLocked(err.data && err.data.preview, (err.data && err.data.price) || state.price);
        return;
      }
      toast("⚠️ " + (err.message || "تعذر إرسال الرسالة"), true);
    }).finally(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------ payment submit */
  function submitPayment() {
    var ref = $("payRef").value.trim();
    var amount = $("payAmount").value.trim().replace(",", ".");
    var btn = $("paySubmit");
    if (!state.screenshotUrl) { toast("⚠️ ارفع صورة الإيصال أولاً", true); return; }
    if (!ref) { toast("⚠️ أدخل رقم المحفظة أو الرقم المرجعي", true); return; }
    var amountNum = parseFloat(amount);
    if (!amount || !isFinite(amountNum) || amountNum <= 0) { toast("⚠️ أدخل المبلغ المدفوع", true); return; }
    btn.disabled = true;
    btn.classList.add("loading");

    window.API.submitPayment({
      method: state.method,
      referenceNumber: ref,
      screenshotUrl: state.screenshotUrl,
      amount: amountNum
    }).then(function (res) {
      if (res.autoApproved) {
        // Instant activation — show the active view right away.
        $("subBody").style.display = "none";
        loadStatus();
        return;
      }
      if (res.autoRejected && res.resubmitAllowed) {
        // Clear the invalid receipt so the user can upload corrected data.
        state.screenshotUrl = "";
        $("payFile").value = "";
        $("payFileBtn").classList.remove("ready");
        $("payFileBtn").textContent = "📎 اضغط لرفع صورة الإيصال (محاولة جديدة)";
        toast("❌ " + (res.message || "طلب مرفوض — عدّل البيانات وحاول مجدداً"), true);
        return;
      }
      // manual review
      $("pendingChip").textContent = "#" + res.transaction.id;
      $("pendingMsg").textContent = "أرسلنا طلبك للإدارة للمراجعة اليدوية للإيصال (#" + res.transaction.id + ") — عادة تتم خلال ساعات. ستصلك رسالة عند الموافقة.";
      showOnly("pendingView");
      $("subBody").style.display = "none";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }).catch(function (err) {
      toast("❌ " + (err.message || "تعذر إرسال طلب الدفع"), true);
    }).finally(function () {
      btn.classList.remove("loading");
      btn.disabled = false;
    });
  }

  /* ------------------------------------------------------ status / active */
  function fmtDays(d) {
    return d <= 0 ? 0 : d;
  }

  function renderTrialBanner(st) {
    var b = $("trialBanner");
    var t = st && st.trial;
    var inTrial = t && t.started && !t.expired && st.status === "trialing";
    if (!inTrial) { b.style.display = "none"; return; }
    var days = fmtDays(t.daysLeft);
    var label = days === 0 ? "آخر يوم اليوم" : (days === 1 ? "يوم واحد متبقٍ" : days + " يوم متبقٍ");
    var ttl = t.days || null;
    var ttlLabel = ttl == null ? "" : (ttl === 1 ? " (يوم واحد)" : ttl === 2 ? " (يومان)" : " (" + ttl + " أيام)");
    $("trialTitle").innerHTML = "🎁 تجربتك المجانية" + ttlLabel + " — <span class=\"count-pill\">" + label + "</span>";
    $("trialSub").textContent = "تنتهي التجربة في " + fmtDate(t.end) +
      " — بعدها يتحول حسابك إلى الاشتراك الشهري (" + st.price + " ج.م/شهر). أول دفعة تُسجَّل فقط بعد انتهاء التجربة.";
    b.style.display = "";
  }

  function renderWarnBanner(st) {
    var b = $("warnBanner");
    if (st.status === "expired") {
      $("warnTitle").textContent = "انتهت فترة وصولك";
      $("warnSub").textContent = "اشترك شهرياً (" + st.price + " ج.م/شهر) لمواصلة استخدام المزايا المميزة — يمكنك الإلغاء في أي وقت وتبقى المزايا حتى نهاية الفترة المدفوعة.";
      b.style.display = "";
    } else if (st.status === "past_due") {
      var g = (st.subscription && st.subscription.graceDaysLeft) || 0;
      $("warnTitle").textContent = "تعذّر تجديد الاشتراك";
      $("warnSub").textContent = "لم نتلقَّ تأكيد التجديد لهذه الفترة. لديك فترة سماح " + g + " يوم متبقية لإتمام الدفع قبل تعطيل المزايا.";
      b.style.display = "";
    } else {
      b.style.display = "none";
    }
  }

  function renderActive(st) {
    var sub = st.subscription || {};
    var endDate = st.subscriptionExpiresAt || sub.periodEnd;
    $("activeChip").textContent = "نشط حتى " + fmtDate(endDate);
    $("activeMsg").textContent = st.userType === "club"
      ? "بوابة التواصل مفعّلة — يمكنك استقبال وإرسال الرسائل بحرية حتى نهاية الفترة المدفوعة."
      : "الرد تم فتحه بالكامل ويمكنك إرسال المزيد بلا حدود.";

    var mc = $("manageCard");
    var rows =
      '<div class="row"><span>الخطة</span><b>' + (sub.plan === "club" ? "🏟️ خطة النادي" : "🎮 خطة اللاعب") + "</b></div>" +
      '<div class="row"><span>السعر</span><b>' + (sub.price != null ? sub.price : st.price) + " " + (sub.currency || "ج.م") + " / شهرياً</b></div>" +
      '<div class="row"><span>نهاية الفترة الحالية</span><b>' + fmtDate(endDate) + "</b></div>" +
      '<div class="row"><span>تاريخ التجديد التالي</span><b>' + fmtDate(sub.nextBillingDate || endDate) + "</b></div>" +
      '<div class="row"><span>الدورة</span><b>شهرياً — تجديد تلقائي</b></div>';
    mc.innerHTML = rows;
    mc.style.display = "";
    $("activeTitle").textContent = sub.status === "cancel_at_period_end" ? "⏳ سيُلغى الاشتراك نهاية الفترة" : (st.userType === "club" ? "🏟️ اشتراك النادي نشط" : "🎉 اشتراكك نشط");

    var cancelled = !!sub.cancelAtPeriodEnd;
    $("cancelBtn").style.display = cancelled ? "none" : "";
    $("resumeBtn").style.display = cancelled ? "" : "none";
    $("cancelNote").textContent = cancelled
      ? "أوقفت التجديد التلقائي — تبقى المزايا مفعّلة حتى " + fmtDate(endDate) + " فقط."
      : "يمكنك إيقاف التجديد في أي وقت — تبقى المزايا حتى نهاية الفترة المدفوعة.";

    var chats = $("activeChats");
    window.API.myChats().then(function (res) {
      var list = (res.chats || []).filter(function (c) { return c.is_revealed; });
      if (!list.length) { chats.innerHTML = ""; return; }
      chats.innerHTML = list.map(function (c) {
        return '<div class="card" style="margin-bottom:12px;text-align:right;">' +
          '<div style="font-size:11.5px;color:var(--gray-500);font-weight:700;margin-bottom:6px;">📤 ' + esc(c.message_text) + "</div>" +
          '<div style="font-size:13.5px;color:var(--gray-700);font-weight:600;line-height:1.8;">🤖 ' + esc(c.ai_response || "") + "</div>" +
          "</div>";
      }).join("");
    }).catch(function () {});
  }

  function loadStatus() {
    return window.API.subscriptionStatus().then(function (st) {
      state.realType = st.userType;
      state.price = st.price;
      setMode(st.userType);

      /* Billing disabled server-side: there is nothing to pay, no trial and
         no paywall. Show the plain "all features available" state and never
         render the price card / checkout form. */
      if (st.billingEnabled === false) {
        showOnly("activeView");
        $("subBody").style.display = "none";
        $("activeTitle").textContent = "كل المميزات متاحة";
        $("activeMsg").textContent =
          "جميع مزايا المنصة مفتوحة لك بالكامل بلا حدود";
        $("activeChip").textContent = "وصول كامل";
        var mc = $("manageCard"); if (mc) mc.style.display = "none";
        var an = $("cancelNote"); if (an) an.textContent = "";
        var cb = $("cancelBtn"); if (cb) cb.style.display = "none";
        var rb = $("resumeBtn"); if (rb) rb.style.display = "none";
        var g = $("goHomeBtn"); if (g) g.style.display = "";
        return;
      }

      // One-shot milestone notifications (each is delivered exactly once).
      if (st.notifications && st.notifications.length) {
        var last = st.notifications[st.notifications.length - 1];
        toast((last.title || "") + " — " + (last.message || ""), false);
      }

      renderTrialBanner(st);
      renderWarnBanner(st);

      if (st.status === "active" || st.status === "cancel_at_period_end") {
        showOnly("activeView");
        $("subBody").style.display = "none";
        renderActive(st);
        return;
      }
      if (st.pendingTransaction) {
        $("pendingChip").textContent = "#" + st.pendingTransaction.id;
        $("pendingMsg").textContent = "لديك طلب دفع قيد المراجعة (#" + st.pendingTransaction.id + ") — نراجع الإيصال وسيُفعل اشتراكك فور الموافقة.";
        showOnly("pendingView");
        $("subBody").style.display = "none";
        return;
      }
      // trialing / past_due / expired / inactive -> show the plan + chat.
      showOnly("gamerView");
      $("subBody").style.display = "";
      if (st.userType === "club") {
        setMode("club");
        showPayCard("club", st.price);
      } else {
        showPayCard("gamer", st.price);
        window.API.myChats().then(function (res) {
          var locked = (res.chats || []).filter(function (c) { return !c.is_revealed; });
          if (locked.length) showLocked(locked[0].preview || "", st.price);
        }).catch(function () {});
      }
    });
  }

  /* ------------------------------------------------------ Kashier online payment */
  function payOnline() {
    var btn = $("payOnlineBtn");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "⏳ جاري تجهيز صفحة الدفع الآمنة...";
    window.API.kashierCheckout()
      .then(function (res) {
        if (res && res.sessionUrl) {
          window.location.href = res.sessionUrl;
          return;
        }
        throw new Error("no session url");
      })
      .catch(function (err) {
        toast(err && err.message ? err.message : "تعذر فتح بوابة الدفع — حاول مجدداً أو استخدم التحويل اليدوي", true);
        btn.disabled = false;
        btn.textContent = "💳 ادفع أونلاين الآن (كارت / محفظة)";
      });
  }

  /* After Kashier redirects back (?kashier=1), the webhook may take a few
     seconds — poll the server until the subscription activates (or timeout). */
  function maybePollKashier() {
    var qp = null;
    try { qp = new URLSearchParams(window.location.search); } catch (e) {}
    if (!qp || qp.get("kashier") !== "1") return;

    toast("🔄 جاري تأكيد الدفع وتفعيل اشتراكك — انتظر لحظات...");
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      window.API.subscriptionStatus().then(function (st) {
        if (st.status === "active" || st.status === "cancel_at_period_end") {
          clearInterval(iv);
          toast("✅ تم تفعيل اشتراكك — مرحباً بك في منارة");
          setTimeout(function () { window.location.href = "subscribe.html"; }, 1600);
        } else if (tries >= 30) {
          clearInterval(iv);
          toast("لم يتم تأكيد الدفع بعد — تفقّد حالة اشتراكك لاحقاً", true);
        }
      }).catch(function () {
        if (tries >= 30) { clearInterval(iv); }
      });
    }, 3000);
  }

  /* ------------------------------------------------------ init */
  function init() {
    if (!window.API || !window.API.token()) {
      $("authPrompt").style.display = "block";
      return;
    }

    window.API.getMe().then(function (me) {
      var user = me.user || {};
      setAuthNav(user);
      // A real user always pays their own plan; keep the switch as a preview.
      document.querySelectorAll(".mode-pill").forEach(function (p) {
        p.addEventListener("click", function () {
          var m = p.dataset.mode;
          setMode(m);
          if ((m === "club") !== (state.realType === "club")) {
            toast("ملاحظة: السعر ثابت حسب نوع حسابك (" + (state.realType === "club" ? "نادي" : "لاعب") + ")", false);
          }
        });
      });

      $("sendChatBtn").addEventListener("click", sendChat);
      $("chatInput").addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
      });
      document.querySelectorAll(".pay-chip").forEach(function (c) {
        c.addEventListener("click", function () {
          state.method = c.dataset.method;
          document.querySelectorAll(".pay-chip").forEach(function (x) {
            x.classList.toggle("active", x.dataset.method === state.method);
          });
        });
      });
      $("payFile").addEventListener("change", function () {
        var f = this.files && this.files[0];
        if (!f) return;
        if (!/^image\//.test(f.type)) { toast("⚠️ ارفع صورة (JPG/PNG/WebP)", true); return; }
        if (f.size > 8 * 1024 * 1024) { toast("⚠️ الصورة كبيرة — الحد 8MB", true); return; }
        var fd = new FormData();
        fd.append("file", f);
        $("payFileBtn").textContent = "⏳ جاري الرفع والفحص…";
        window.API.upload(fd, "payment_receipt").then(function (res) {
          var file = res.files && res.files[0];
          if (!file) throw new Error("no file");
          state.screenshotUrl = file.url;
          $("payFileBtn").textContent = "✅ تم رفع الإيصال وفحصه";
          $("payFileBtn").classList.add("ready");
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر رفع الإيصال"), true);
          $("payFileBtn").textContent = "📎 اضغط لرفع صورة الإيصال";
        });
      });
      $("paySubmit").addEventListener("click", submitPayment);
      $("payOnlineBtn").addEventListener("click", payOnline);
      maybePollKashier();
      $("cancelBtn").addEventListener("click", function () {
        var b = $("cancelBtn");
        b.disabled = true;
        window.API.subscriptionCancel().then(function (res) {
          toast("✅ " + (res.message || "تم إيقاف التجديد"), false);
          return loadStatus();
        }).catch(function (err) {
          toast("⚠️ " + (err.message || "تعذر الإلغاء"), true);
        }).finally(function () { b.disabled = false; });
      });
      $("resumeBtn").addEventListener("click", function () {
        var b = $("resumeBtn");
        b.disabled = true;
        window.API.subscriptionResume().then(function (res) {
          toast("✅ " + (res.message || "أُعيد تفعيل التجديد"), false);
          return loadStatus();
        }).catch(function (err) {
          toast("⚠️ " + (err.message || "تعذر إعادة التفعيل"), true);
        }).finally(function () { b.disabled = false; });
      });
      $("checkStatusBtn").addEventListener("click", function () {
        loadStatus().then(function () { if ($("pendingView").style.display !== "none") toast("⏳ لا يزال قيد المراجعة — تحقق لاحقاً", false); });
      });
      $("goHomeBtn").addEventListener("click", function () { window.location.href = "index.html"; });

      // Club demo modal
      var dm = $("demoModal");
      $("demoBtn").addEventListener("click", function () { dm.classList.add("open"); });
      $("demoClose").addEventListener("click", function () { dm.classList.remove("open"); });
      dm.addEventListener("click", function (e) { if (e.target === dm) dm.classList.remove("open"); });
      $("demoSend").addEventListener("click", function () {
        var name = $("dName").value.trim(), email = $("dEmail").value.trim();
        if (!name || !email) { toast("⚠️ أضف اسم النادي والبريد أولاً", true); return; }
        dm.classList.remove("open");
        $("dName").value = ""; $("dEmail").value = ""; $("dPhone").value = "";
        toast("✅ تم إرسال الطلب — سنتواصل معك خلال 24 ساعة");
      });

      loadStatus();
    }).catch(function () {
      // Invalid/expired token -> login
      $("authPrompt").style.display = "block";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();