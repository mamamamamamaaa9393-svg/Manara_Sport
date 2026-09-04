/* ==========================================================================
   Manara — shared subscription banner.
   Every page that used to show "⏳ trial — subscribe now" decided that from
   `st.trial` ALONE. But the status endpoint also returns `trial` for a user
   who has ALREADY PAID (their trialEnd is still in the future while
   subscriptionStatus is "active"). So paying users saw the trial CTA.

   This helper is the single source of truth: it checks the REAL state
   (status + pendingTransaction) and ONLY shows "subscribe now" when the user
   is genuinely in a free trial with no payment submitted. A paid (active)
   subscription, a payment under review, or a cancelled-at-period-end all
   suppress the misleading prompt.
   ========================================================================== */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(iso) {
    try { return new Date(iso).toLocaleDateString("ar-EG"); } catch (e) { return ""; }
  }

  function banner(emoji, title, bodyHtml) {
    return '<div style="display:flex;gap:12px;align-items:center;background:linear-gradient(135deg,var(--primary-light),var(--green-bg));border:1px solid var(--primary);border-radius:14px;padding:12px 16px;margin-bottom:18px;">' +
      '<span style="font-size:24px;">' + emoji + "</span>" +
      '<div style="flex:1;">' +
      '<div style="font-weight:900;color:var(--dark);font-size:14px;">' + title + "</div>" +
      '<div style="color:var(--gray-600);font-weight:600;font-size:12.5px;margin-top:3px;line-height:1.7;">' + bodyHtml + "</div>" +
      "</div></div>";
  }

  // Render the correct subscription banner into `el` based on `st`
  // (the /api/subscription/status response).
  function render(el, st) {
    if (!el) return;
    if (!st) { el.style.display = "none"; return; }

    var price = st.price != null ? st.price : "";
    var currency = st.currency || "ج.م";
    var sub = st.subscription;

    // 1) Active paid subscription (or cancelled-at-period-end): the user has
    //    PAID — never show "subscribe now". Confirm it instead.
    if (st.status === "active" || st.status === "cancel_at_period_end") {
      var until = (sub && sub.periodEnd) ? fmt(sub.periodEnd) : "";
      el.innerHTML = banner(
        "✅",
        st.status === "cancel_at_period_end" ? "اشتراكك مفعّل حتى نهاية الفترة المدفوعة" : "اشتراكك مفعّل",
        until
          ? ("مفعّل حتى " + until + '. <a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">إدارة الاشتراك ←</a>')
          : '<a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">إدارة الاشتراك ←</a>'
      );
      el.style.display = "";
      return;
    }

    // 2) A payment was submitted and is awaiting admin verification. The user
    //    already PAID — do NOT show "subscribe now" again.
    if (st.pendingTransaction || st.status === "pending") {
      var pid = st.pendingTransaction ? st.pendingTransaction.id : "";
      el.innerHTML = banner(
        "⏳",
        "طلب الدفع قيد المراجعة",
        "أرسلنا إيصالك" + (pid ? " (#" + esc(pid) + ")" : "") + " للمراجعة — سيُفعل اشتراكك فور الموافقة. لا حاجة للدفع مرة أخرى."
      );
      el.style.display = "";
      return;
    }

    // 3) Live free trial: the ONLY case where "subscribe now" appears.
    if (st.status === "trialing" && st.trial && !st.trial.expired) {
      var days = Math.max(0, st.trial.daysLeft || 0);
      var ttl = st.trial.days || null;
      var ttlLabel = ttl == null ? "" : (ttl === 1 ? " (يوم واحد)" : ttl === 2 ? " (يومان)" : " (" + ttl + " أيام)");
      el.innerHTML = banner(
        "🎁",
        "تجربتك المجانية" + ttlLabel + " — " + days + " يوم متبقٍ",
        "تنتهي في " + fmt(st.trial.end) + '. اشترك الآن لتجنّب انقطاع المزايا. <a href="subscribe.html" style="color:var(--primary);font-weight:800;text-decoration:none;">اشترك الآن ←</a>'
      );
      el.style.display = "";
      return;
    }

    // 4) Expired (trial ended, no payment): prompt to subscribe.
    if (st.status === "expired") {
      el.innerHTML = banner(
        "⏰",
        "انتهت فترة وصول حسابك",
        "اشترك شهرياً (" + price + " " + currency + "/شهر) لمواصلة استخدام المزايا. <a href=\"subscribe.html\" style=\"color:var(--primary);font-weight:800;text-decoration:none;\">اشترك الآن ←</a>"
      );
      el.style.display = "";
      return;
    }

    // 5) Past due (billing lapsed, within grace): prompt to renew.
    if (st.status === "past_due") {
      el.innerHTML = banner(
        "⏰",
        "اشتراكك بحاجة إلى تجديد",
        "انتهت الفترة المدفوعة — جدّد اشتراكك (" + price + " " + currency + "/شهر) للمتابعة. <a href=\"subscribe.html\" style=\"color:var(--primary);font-weight:800;text-decoration:none;\">جدّد الآن ←</a>"
      );
      el.style.display = "";
      return;
    }

    // Anything else: hide the banner.
    el.style.display = "none";
  }

  window.SubBanner = { render: render };
})();
