/* ==========================================================================
   Manara knowledge admin panel (admin-faq.html) — section 3 of the plan.
   Full CRUD for FAQ entries (bilingual, categories, enable/disable, search),
   the platform-params source-of-truth view (config auto-extraction, stale
   highlight, manual sync), and a chat-style preview showing how an answer
   will appear inside the AI assistant (including a real model test).
   ========================================================================== */
(function () {
  "use strict";

  var state = {
    faqs: [],
    categories: [],
    catLabels: {},
    params: [],
    paramGroups: [],
    groupLabels: {},
    catFilter: "",
    statusFilter: "",
    search: ""
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg, isError) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    if (isError) t.style.background = "#ef4444"; else t.style.background = "";
    t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 3500);
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("ar-EG"); } catch (e) { return ""; }
  }

  /* ---- generic modal builder (mirrors admin.js) ------------------------- */
  function buildSimpleModal(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal-box narrow" role="dialog" aria-modal="true">' +
          '<div class="modal-msg">' + (opts.message || "") + '</div>' +
          '<div class="modal-actions">' +
            '<button class="modal-btn modal-cancel" type="button">' + (opts.cancelText || "إلغاء") + '</button>' +
            '<button class="modal-btn modal-ok ' + (opts.danger ? "danger" : "") + '" type="button">' + (opts.okText || "تأكيد") + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var okBtn = overlay.querySelector(".modal-ok");
      var cancelBtn = overlay.querySelector(".modal-cancel");
      function close(val) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(val); }
      okBtn.focus();
      cancelBtn.addEventListener("click", function () { close(false); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(false); });
      okBtn.addEventListener("click", function () { close(true); });
    });
  }
  function confirmDialog(message, okText, danger) {
    return buildSimpleModal({ message: message, okText: okText || "تأكيد", danger: danger !== false });
  }

  /* ---- FAQ: form modal (create / edit) ---------------------------------- */
  function faqFormModal(existing) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      var f = existing || {};
      var q = f.question || {}, a = f.answer || {};
      overlay.innerHTML =
        '<div class="modal-box" role="dialog" aria-modal="true">' +
          '<form id="faqForm">' +
          '<div class="modal-field"><label>السؤال (عربي) *</label>' +
            '<textarea id="f_qAr" rows="2" required>' + esc(q.ar) + '</textarea></div>' +
          '<div class="modal-field"><label>السؤال (إنجليزي) — اختياري</label>' +
            '<textarea id="f_qEn" rows="2">' + esc(q.en) + '</textarea></div>' +
          '<div class="modal-field"><label>الإجابة (عربي) *</label>' +
            '<textarea id="f_aAr" rows="4" required>' + esc(a.ar) + '</textarea></div>' +
          '<div class="modal-field"><label>الإجابة (إنجليزي) — اختياري</label>' +
            '<textarea id="f_aEn" rows="4">' + esc(a.en) + '</textarea></div>' +
          '<div class="modal-row">' +
            '<div class="modal-field"><label>الفئة</label><select id="f_cat">' + catOptions(f.category) + '</select></div>' +
            '<div class="modal-field"><label>الأولوية (أعلى = يظهر أولاً)</label><input id="f_prio" type="number" step="1" value="' + esc(f.priority || 0) + '"></div>' +
          '</div>' +
          '<div class="modal-field"><label>المصدر / الرابط المرجعي — اختياري</label>' +
            '<input id="f_src" type="text" value="' + esc(f.source || "") + '" placeholder="https://... أو صفحة المنصة"></div>' +
          '<div class="modal-field" style="display:flex;align-items:center;gap:8px;">' +
            '<input id="f_active" type="checkbox" style="width:auto;border-radius:6px;" ' + (f.isActive !== false ? "checked" : "") + '>' +
            '<label for="f_active" style="margin:0;">نشط (متاح للمساعد الذكي)</label></div>' +
          '<div class="modal-actions">' +
            '<button class="modal-btn modal-cancel" type="button" id="f_cancel">إلغاء</button>' +
            '<button class="modal-btn modal-ok" type="submit">' + (existing ? "💾 حفظ التعديلات" : "➕ إضافة") + '</button>' +
          '</div>' +
          '</form>' +
        '</div>';
      document.body.appendChild(overlay);
      var form = overlay.querySelector("#faqForm");
      overlay.querySelector("#f_cancel").addEventListener("click", function () { close(); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
      function close(data) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(data); }
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var arQ = form.elements && overlay.querySelector("#f_qAr");
        var payload = {
          question: { ar: val("#f_qAr"), en: val("#f_qEn") },
          answer: { ar: val("#f_aAr"), en: val("#f_aEn") },
          category: overlay.querySelector("#f_cat").value,
          priority: Number(overlay.querySelector("#f_prio").value) || 0,
          source: overlay.querySelector("#f_src").value.trim(),
          isActive: overlay.querySelector("#f_active").checked
        };
        close(payload);
      });
      setTimeout(function () { overlay.querySelector("#f_qAr").focus(); }, 30);
    });
  }

  function catOptions(selected) {
    return state.categories.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === selected ? " selected" : "") + '>' +
        esc(state.catLabels[c] || c) + '</option>';
    }).join("");
  }

  function val(id) {
    if (typeof id !== "string" || !id) return "";
    if (id.charAt(0) === "#") id = id.slice(1);
    var el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  /* ---- FAQ: rendering ---------------------------------------------------- */
  function faqCard(f) {
    var q = f.question || {}, a = f.answer || {};
    var qText = q.ar || q.en || "";
    var qEn = q.en && q.en !== q.ar ? '<span class="q-en">' + esc(q.en) + '</span>' : "";
    var aText = a.ar || a.en || "";
    return '<div class="faq-card" data-id="' + esc(f.id) + '">' +
      '<div class="faq-head">' +
        '<div class="faq-q"><b>' + esc(qText) + '</b>' + qEn + '</div>' +
        '<span class="badge cat">' + esc(state.catLabels[f.category] || f.category) + '</span>' +
        '<span class="badge ' + (f.isActive !== false ? "st-on" : "st-off") + '">' + (f.isActive !== false ? "نشط" : "معطّل") + '</span>' +
      '</div>' +
      '<div class="faq-body">' +
        '<div class="faq-a">' + esc(aText) + '</div>' +
        '<div class="faq-meta">' +
          (f.priority > 0 ? "<span>⭐ أولوية " + esc(f.priority) + "</span>" : "") +
          (f.source ? '<span>📎 <span dir="ltr">' + esc(f.source) + '</span></span>' : "") +
          "<span>🕓 آخر تعديل: " + esc(fmtDate(f.updatedAt)) + "</span>" +
        '</div>' +
      '</div>' +
      '<div class="faq-actions">' +
        '<button class="btn-sm" data-act="preview">👁️ معاينة المساعد</button>' +
        '<button class="btn-sm" data-act="edit">✏️ تعديل</button>' +
        '<button class="btn-sm danger" data-act="del">🗑️ حذف</button>' +
        '<label class="switch">' +
          (f.isActive !== false ? "نشط" : "معطّل") +
          '<input type="checkbox" data-act="toggle"' + (f.isActive !== false ? " checked" : "") + '><span class="track"></span>' +
        '</label>' +
      '</div>' +
    '</div>';
  }

  function filteredFaqs() {
    var q = state.search.trim().toLowerCase();
    return state.faqs.filter(function (f) {
      if (state.catFilter && f.category !== state.catFilter) return false;
      if (state.statusFilter === "on" && f.isActive === false) return false;
      if (state.statusFilter === "off" && f.isActive !== false) return false;
      if (!q) return true;
      var hay = (f.question.ar + " " + f.question.en + " " + f.answer.ar + " " + f.answer.en).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderFaqs() {
    var list = document.getElementById("faqList");
    var rows = filteredFaqs();
    list.innerHTML = rows.length ? rows.map(faqCard).join("") : '<div class="empty">لا توجد أسئلة مطابقة — أضف سؤالاً جديداً أو غيّر عوامل التصفية.</div>';
    var stats = document.getElementById("faqStats");
    var active = state.faqs.filter(function (f) { return f.isActive !== false; }).length;
    stats.innerHTML =
      '<span class="stat-pill">📚 الإجمالي: <b>' + state.faqs.length + '</b></span>' +
      '<span class="stat-pill">✅ نشط: <b>' + active + '</b></span>' +
      '<span class="stat-pill">الظاهر الآن: <b>' + rows.length + '</b></span>';
  }

  /* ---- FAQ: actions ------------------------------------------------------- */
  function bindFaqActions() {
    document.querySelectorAll("#faqList .faq-card").forEach(function (card) {
      var id = card.dataset.id;
      card.querySelectorAll("[data-act]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          var act = btn.dataset.act;
          if (act === "toggle") e.preventDefault();
          handleFaqAction(act, id, btn);
        });
      });
    });
  }

  function findFaq(id) {
    return state.faqs.find(function (f) { return f.id === id; });
  }

  async function handleFaqAction(act, id, btn) {
    if (act === "toggle") {
      var f = findFaq(id);
      btn.disabled = true;
      try {
        await window.API.knowledgeUpdateFaq(id, { isActive: f.isActive === false ? true : false });
        toast(f.isActive === false ? "✅ تم التفعيل" : "⏸️ تم التعطيل");
        reloadFaqs();
      } catch (err) {
        toast("❌ " + (err.message || "فشل التغيير"), true);
        btn.disabled = false;
      }
      return;
    }
    if (act === "del") {
      var ok = await confirmDialog("حذف هذا السؤال/الجواب نهائياً؟", "حذف", true);
      if (!ok) return;
      btn.disabled = true;
      try {
        await window.API.knowledgeDeleteFaq(id);
        toast("🗑️ تم الحذف");
        reloadFaqs();
      } catch (err) {
        toast("❌ " + (err.message || "فشل الحذف"), true);
        btn.disabled = false;
      }
      return;
    }
    if (act === "edit") { openFaqForm(findFaq(id)); return; }
    if (act === "preview") { openPreview(findFaq(id)); return; }
  }

  async function openFaqForm(existing) {
    var payload = await faqFormModal(existing);
    if (!payload) return;
    if (!payload.question.ar && !payload.question.en) { toast("⚠️ اكتب السؤال", true); return; }
    if (!payload.answer.ar && !payload.answer.en) { toast("⚠️ اكتب الإجابة", true); return; }
    try {
      if (existing) {
        await window.API.knowledgeUpdateFaq(existing.id, payload);
        toast("✅ تم حفظ التعديلات");
      } else {
        await window.API.knowledgeCreateFaq(payload);
        toast("✅ أُضيفت الإجابة بنجاح");
      }
      reloadFaqs();
    } catch (err) {
      toast("❌ " + (err.message || "فشل الحفظ"), true);
    }
  }

  /* ---- preview: how the answer appears inside the assistant ------------- */
  function bubble(cls, text) {
    var div = document.createElement("div");
    div.className = "ai-msg " + cls;
    div.textContent = text;
    return div;
  }

  function openPreview(f) {
    var q = (f.question && (f.question.ar || f.question.en)) || "";
    var a = (f.answer && (f.answer.ar || f.answer.en)) || "";
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-box" role="dialog" aria-modal="true">' +
        '<div class="modal-msg" style="margin-bottom:4px;">👁️ معاينة كيف سيرد المساعد</div>' +
        '<div class="ai-preview" id="pvBox"></div>' +
        '<div class="ai-note" id="pvNote">الإجابة أعلاه من قاعدة المعرفة. زر "اختبار الرد الحقيقي" يرسل السؤال إلى نموذج المساعد الفعلي لرؤية رده المباشر.</div>' +
        '<div class="modal-actions">' +
          '<button class="modal-btn modal-cancel" type="button" id="pvClose">إغلاق</button>' +
          '<button class="modal-btn modal-ok" type="button" id="pvTest">🚀 اختبار الرد الحقيقي</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var box = overlay.querySelector("#pvBox");
    box.appendChild(bubble("user", q || "…"));
    box.appendChild(bubble("bot", a || "…"));
    var testBtn = overlay.querySelector("#pvTest");
    var closeBtn = overlay.querySelector("#pvClose");
    function closeMe() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    closeBtn.addEventListener("click", closeMe);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeMe(); });
    testBtn.addEventListener("click", async function () {
      testBtn.disabled = true;
      testBtn.textContent = "⏳ جارٍ الاختبار...";
      var loading = bubble("bot", "…");
      box.appendChild(loading);
      try {
        var res = await window.API.knowledgePreview(q);
        loading.remove();
        if (res && res.reply) box.appendChild(bubble("bot", res.reply));
        else box.appendChild(bubble("bot", res && res.error ? res.error : "لا يوجد رد"));
        var note = overlay.querySelector("#pvNote");
        note.textContent = "المصدر: " + (res.provider || "؟") + (res.scope ? " · النطاق: " + res.scope : "") + " — أثناء التطوير يُوجَّه الرد عادة إلى قاعدة المعرفة.";
      } catch (err) {
        loading.remove();
        box.appendChild(bubble("bot error", "⚠️ " + (err.message || "تعذر الاختبار")));
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "🚀 اختبار الرد الحقيقي";
        box.scrollTop = box.scrollHeight;
      }
    });
  }

  /* ---- data loading ------------------------------------------------------ */
  function reloadFaqs() {
    window.API.knowledgeFaqs().then(function (res) {
      state.faqs = res.faqs || [];
      state.categories = res.categories || [];
      state.catLabels = res.categoryLabels || {};
      renderFaqs();
      bindFaqActions();
      populateCatFilter();
    }).catch(function (err) {
      showErr(err.message || "تعذر تحميل الأسئلة");
    });
  }

  function populateCatFilter() {
    var sel = document.getElementById("faqCat");
    var keep = sel.value;
    sel.innerHTML = '<option value="">كل الفئات</option>' + catOptions("");
    sel.value = state.catFilter;
    void keep;
  }

  /* ---- platform params ---------------------------------------------------- */
  function renderParams() {
    var list = document.getElementById("paramsList");
    if (!state.params.length) {
      list.innerHTML = '<div class="empty">لا توجد معلمات بعد — اضغط "فحص التغييرات" ثم "تطبيق الكل" لتوليدها من الإعدادات.</div>';
    } else {
      list.innerHTML = state.params.map(paramRow).join("");
    }
    var stale = state.params.filter(function (p) { return p.stale === true; });
    var banner = document.getElementById("staleBanner");
    if (stale.length) {
      banner.className = "stale-banner show";
      banner.innerHTML = "⚠️ <b>" + stale.length + "</b> معلمة خارج المزامنة مع الإعدادات (القيم الحالية قد تختلف عمّا يراه المستخدم): " +
        stale.map(function (p) { return '<b dir="ltr">' + esc(p.key) + '</b>'; }).join("، ") +
        " — استخدم زر المزامنة لكل معلمة أو " + "تطبيق كل القيم" + ".";
    } else {
      banner.className = "stale-banner";
      banner.innerHTML = "";
    }
  }

  function paramRow(p) {
    var display = kmP(p);
    var badge = p.source === "auto-config"
      ? '<span class="badge st-auto">آلي (' + esc(p.configRef || "") + ')</span>'
      : '<span class="badge st-manual">يدوي</span>';
    var syncBtn = p.source === "auto-config"
      ? '<button class="btn-sm" data-pkey="' + esc(p.key) + '">↻ مزامنة</button>'
      : "";
    var valueHtml;
    if (p.stale) {
      valueHtml = '<span class="param-value"><span class="param-old">' + esc(display) + '</span>' +
        (p.configValue !== null && p.configValue !== undefined
          ? ' ← <span class="param-new">' + esc(km.displayParamValue(p.configValue)) + '</span>'
          : "") + '</span>';
    } else {
      valueHtml = '<span class="param-value">' + esc(display) + '</span>';
    }
    return '<div class="param-row' + (p.stale ? " stale" : "") + '">' +
      '<span class="param-key">' + esc(p.key) + '</span>' +
      '<span class="param-label">' + esc(p.label.ar || p.label.en || "") +
        '<small dir="ltr">' + esc(p.label.en || "") + '</small></span>' +
      valueHtml +
      '<span class="badge ' + (p.stale ? "st-stale" : (p.source === "auto-config" ? "st-auto" : "st-manual")) + '">' +
        (p.stale ? "⚠️ قديمة" : (p.source === "auto-config" ? "آلي" : "يدوي")) + '</span>' +
      '<span class="param-actions">' + syncBtn + '</span>' +
    '</div>';
  }

  function kmP(p) {
    var v = p.value;
    if (Array.isArray(v)) return v.length ? v.join("، ") : "(فارغ)";
    if (v === null || v === undefined) return "—";
    return String(v);
  }

  function renderReport(report) {
    var box = document.getElementById("reportBox");
    if (!report) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="report-msg">آخر فحص (الساعة ' + esc(fmtDate(report.scannedAt)) + '): ' +
        '<b class="ok">+إضافة ' + report.added.length + '</b> · ' +
        '<b class="warn">تغيّر (قديمة) ' + report.stale.length + '</b> · ' +
        'بدون تغيير ' + report.unchanged.length + ' · ' +
        'مُزال من الإعدادات ' + report.removed.length + ' · ' +
        'يدوي (لا تُمس) ' + report.manual.length + '</div>' +
      (report.stale.length || report.removed.length
        ? '<div class="report-msg">🔁 التغييرات: ' +
            report.stale.map(function (s) { return '<span dir="ltr">' + esc(s.key) + '</span> (' + esc(s.previous) + ' → ' + esc(s.current) + ')'; }).join("، ") +
            (report.removed.length ? ' — لم تعد في الإعدادات: ' + report.removed.map(esc).join("، ") : "") +
          '</div>'
        : "") +
      '<div class="report-msg" style="color:var(--gray-400);">' + (report.applyRun ? "✔️ تم التطبيق وحفظ البيانات." : "وضع المعاينة — لم تتغير البيانات.") + '</div>';
  }

  function loadParams() {
    window.API.knowledgeParams().then(function (res) {
      state.params = res.params || [];
      state.paramGroups = res.groups || [];
      state.groupLabels = res.groupLabels || {};
      renderParams();
      bindParamActions();
    }).catch(function (err) {
      showErr(err.message || "تعذر تحميل المعلمات");
    });
  }

  function bindParamActions() {
    document.querySelectorAll('[data-pkey]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var key = btn.dataset.pkey;
        btn.disabled = true;
        try {
          var res = await window.API.knowledgeApplyParam(key);
          toast((res.created ? "✅ أُضيفت" : "↻ حُدّثت") + ": " + res.key + " = " + res.value);
          loadParams();
        } catch (err) {
          toast("❌ " + (err.message || "فشل المزامنة"), true);
          btn.disabled = false;
        }
      });
    });
  }

  async function doReconcile(apply) {
    try {
      var res = await window.API.knowledgeReconcile(apply);
      var report = res.report || {};
      report.applyRun = apply;
      renderReport(report);
      if (apply) {
        toast("✅ تم تطبيق " + report.added.length + " معلمة جديدة و" + report.stale.length + " تحديث");
        loadParams();
      } else {
        toast("🔍 تم الفحص — بدون تغيير data");
      }
    } catch (err) {
      toast("❌ " + (err.message || "فشل الفحص"), true);
    }
  }

  async function doExport() {
    try {
      var res = await window.API.knowledgeExport();
      var blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "manara-knowledge-export.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast("📤 تم تصدير " + res.meta.faqCount + " سؤال و" + res.meta.paramCount + " معلمة");
    } catch (err) {
      toast("❌ " + (err.message || "فشل التصدير"), true);
    }
  }

  /* ---- wiring ------------------------------------------------------------- */
  function showErr(msg) {
    var bar = document.getElementById("errBar");
    bar.style.display = "block";
    bar.textContent = "⚠️ " + msg;
  }

  function switchMode(mode) {
    document.querySelectorAll(".mode-btn").forEach(function (x) { x.classList.remove("active"); });
    document.querySelector('.mode-btn[data-mode="' + mode + '"]').classList.add("active");
    document.getElementById("faqPanel").style.display = mode === "faq" ? "" : "none";
    document.getElementById("paramsPanel").style.display = mode === "params" ? "" : "none";
    if (mode === "params") loadParams();
  }

  document.querySelectorAll(".mode-btn").forEach(function (mb) {
    mb.addEventListener("click", function () { switchMode(mb.dataset.mode); });
  });

  var searchInput = document.getElementById("faqSearch");
  searchInput.addEventListener("input", function () { state.search = searchInput.value; renderFaqs(); bindFaqActions(); });
  document.getElementById("faqCat").addEventListener("change", function (e) { state.catFilter = e.target.value; renderFaqs(); bindFaqActions(); });
  document.getElementById("faqStatus").addEventListener("change", function (e) { state.statusFilter = e.target.value; renderFaqs(); bindFaqActions(); });
  document.getElementById("addFaqBtn").addEventListener("click", function () { openFaqForm(null); });
  document.getElementById("reconcileBtn").addEventListener("click", function () { doReconcile(false); });
  document.getElementById("applyAllBtn").addEventListener("click", async function () {
    var ok = await confirmDialog("سيتم استخراج كل قيم الإعدادات وحفظها في المعلمات (اليدوية لن تُمس). متابعة؟", "تطبيق", false);
    if (ok) doReconcile(true);
  });
  document.getElementById("exportBtn").addEventListener("click", doExport);

  var lo = document.getElementById("logoutBtn");
  if (lo) lo.addEventListener("click", function () {
    window.API.logout();
    window.location.href = "Sign/Sign_In.html";
  });

  (function init() {
    if (!window.API.token()) { window.location.href = "Sign/Sign_In.html"; return; }
    window.API.getMe().then(function (me) {
      if (!me.user || me.user.role !== "admin") { window.location.href = "index.html"; return; }
      document.getElementById("adminName").textContent = me.user.name || "Admin";
      reloadFaqs();
    }).catch(function () {
      window.location.href = "Sign/Sign_In.html";
    });
  })();
})();