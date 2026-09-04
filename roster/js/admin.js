/* ==========================================================================
   Manara admin panel — reviews registration requests (players + clubs).
   Shows the proof documents (birth certificate, medical report, declaration
   / official letter + license), approves or rejects them.
   ========================================================================== */
(function () {
  "use strict";

  var currentStatus = "all";

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

  // Mobile-friendly modal dialogs (replace window.confirm / window.prompt which
  // are hard to use / unreliable on phones and block the UI thread).
  function buildModal(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal-box" role="dialog" aria-modal="true">' +
          '<div class="modal-msg">' + (opts.message || "") + '</div>' +
          (opts.input
            ? '<textarea class="modal-input" rows="3" placeholder="' + esc(opts.placeholder || "") + '">' + esc(opts.value || "") + '</textarea>'
            : "") +
          '<div class="modal-actions">' +
            '<button class="modal-btn modal-cancel" type="button">' + (opts.cancelText || "إلغاء") + '</button>' +
            '<button class="modal-btn modal-ok ' + (opts.danger ? "modal-danger" : "") + '" type="button">' + (opts.okText || "تأكيد") + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var input = overlay.querySelector(".modal-input");
      var okBtn = overlay.querySelector(".modal-ok");
      var cancelBtn = overlay.querySelector(".modal-cancel");
      function close(val) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(val); }
      setTimeout(function () { if (input) input.focus(); else okBtn.focus(); }, 30);
      cancelBtn.addEventListener("click", function () { close(opts.input ? null : false); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(opts.input ? null : false); });
      okBtn.addEventListener("click", function () {
        if (opts.input) { var v = input ? input.value.trim() : ""; close(v); }
        else close(true);
      });
    });
  }
  function confirmDialog(message, okText, danger) {
    return buildModal({ message: message, okText: okText || "تأكيد", danger: danger !== false });
  }
  function promptDialog(message, value, placeholder, okText) {
    return buildModal({ message: message, input: true, value: value || "", placeholder: placeholder || "", okText: okText || "إرسال" });
  }

  var DOC_LABELS = {
    birth_cert: "شهادة الميلاد",
    medical: "التقرير الطبي",
    declaration: "صورة الإقرار",
    official_letter: "الخطاب الرسمي",
    license: "الرخصة / السجل التجاري"
  };

  function docCard(key, url) {
    if (!url) return "";
    var safeUrl = esc(url);
    var isPdf = /\.pdf($|\?)/i.test(url);
    return '<div class="doc-card"><a href="' + safeUrl + '" target="_blank" rel="noopener">' +
      '<div class="doc-preview">' + (isPdf ? '<span class="pdf-ico">📄</span>' : '<img src="' + safeUrl + '" alt="" loading="lazy">') + '</div>' +
      '<div class="doc-label"><span>' + esc(DOC_LABELS[key] || key) + '</span><span class="open">عرض ↗</span></div>' +
      '</a></div>';
  }

  function statusBadge(status) {
    var map = { pending: "⏳ بانتظار المراجعة", approved: "✅ مقبول", rejected: "❌ مرفوض" };
    return '<span class="badge st-' + status + '">' + (map[status] || status) + '</span>';
  }

  function roleBadge(role) {
    return role === "club"
      ? '<span class="badge role-club">🏟️ نادي</span>'
      : '<span class="badge role-player">🏅 رياضي</span>';
  }

  function card(reg) {
    var d = reg.data || {};
    var meta = [];
    if (reg.role === "player") {
      if (d.sport) meta.push("<div><span>الرياضة</span>" + esc(d.sport) + "</div>");
      if (d.position) meta.push("<div><span>المركز</span>" + esc(d.position) + "</div>");
    } else {
      if (d.club_type) meta.push("<div><span>النوع</span>" + esc(d.club_type) + "</div>");
      if (d.sport) meta.push("<div><span>الرياضة</span>" + esc(d.sport) + "</div>");
    }
    meta.push("<div><span>تاريخ التقديم</span>" + esc(fmtDate(reg.submittedAt)) + "</div>");
    if (reg.videos && reg.videos.length) meta.push("<div><span>الفيديوهات</span>" + reg.videos.length + "</div>");

    var docs = "";
    if (reg.role === "player") {
      docs = docCard("birth_cert", reg.documents && reg.documents.birth_cert)
        + docCard("medical", reg.documents && reg.documents.medical)
        + docCard("declaration", reg.documents && reg.documents.declaration);
    } else {
      docs = docCard("official_letter", reg.documents && reg.documents.official_letter)
        + docCard("license", reg.documents && reg.documents.license);
    }

    var vids = "";
    if (reg.videos && reg.videos.length) {
      vids = '<div class="vids">' + reg.videos.map(function (v, idx) {
        return '<a class="vid-link" href="' + esc(v.url || v.secureUrl || "#") + '" rel="noopener">▶️ تشغيل الفيديو ' + (reg.videos.length > 1 ? (idx + 1) : "") + ' — ' + esc(v.name || "فيديو") + '</a>';
      }).join("") + '</div>';
    }

    var note = "";
    if (reg.status === "rejected") {
      note = '<div class="reg-note rejected">❌ مرفوض' + (reg.adminNote ? " — السبب: " + esc(reg.adminNote) : "") +
        (reg.retryAfter ? '<br>🕓 يُسمح بإعادة التقديم بعد: ' + esc(fmtDate(reg.retryAfter)) : "") + '</div>';
    } else if (reg.status === "approved") {
      note = '<div class="reg-note ok">✅ تمت الموافقة — الحساب أصبح نشطاً ' + (reg.reviewedAt ? "في " + esc(fmtDate(reg.reviewedAt)) : "") + '</div>';
    }

    var actions = '<div class="reg-actions">';
    if (reg.status === "pending") {
      actions +=
        '<button class="btn-act btn-approve" data-approve="' + esc(reg.id) + '">✅ قبول الطلب</button>' +
        '<button class="btn-act btn-reject" data-reject="' + esc(reg.id) + '">❌ رفض الطلب</button>';
    }
    if (reg.userId) {
      actions += '<button class="btn-act btn-delete" data-delete="' + esc(reg.userId) + '" ' +
        'style="background:#dc2626;color:#fff;border-color:#dc2626">🗑️ حذف الحساب نهائياً</button>';
    }
    actions += '</div>';
    if (actions === '<div class="reg-actions"></div>') actions = "";

    var photo = reg.photo
      ? '<img src="' + esc(reg.photo) + '" alt="" loading="lazy">'
      : (reg.role === "club" ? "🏟️" : "🏅");

    return '<div class="reg-card">' +
      '<div class="reg-head">' +
        '<div class="reg-ava">' + photo + '</div>' +
        '<div class="reg-who"><b>' + esc(reg.name) + '</b><br><span class="reg-email">' + esc(reg.email) + '</span></div>' +
        roleBadge(reg.role) + statusBadge(reg.status) +
        '<div class="reg-sub">#' + esc(reg.id) + '</div>' +
      '</div>' +
      '<div class="reg-body">' +
        '<div class="reg-meta">' + meta.join("") + '</div>' +
        '<div class="docs">' + docs + '</div>' +
        vids + note +
      '</div>' + actions + '</div>';
  }

  function loadAll() {
    window.API.adminRegistrations("all").then(function (all) {
      var counts = all.counts || {};
      ["pending", "approved", "rejected"].forEach(function (k) {
        var el = document.getElementById("c-" + k);
        if (el) el.textContent = counts[k] || 0;
      });
    }).catch(function () {});

    window.API.adminRegistrations(currentStatus).then(function (res) {
      var list = document.getElementById("regList");
      var html;
      if (!res.registrations || !res.registrations.length) {
        html = '<div class="empty">لا توجد طلبات في هذه القائمة الآن</div>';
      } else {
        html = res.registrations.map(card).join("");
      }
      if (list.innerHTML !== html) {
        list.innerHTML = html;
        bindActions();
        authedImgs(list);
      }
    }).catch(function (err) {
      var bar = document.getElementById("errBar");
      bar.style.display = "block";
      bar.textContent = "⚠️ " + (err.message || "تعذر تحميل الطلبات");
    });
  }

  function logCard(l) {
    var d = l.deleted || {};
    function add(n, label) { return n ? label + ": " + n : ""; }
    var parts = [
      add(d.players, "ملفات رياضيين"), add(d.clubs, "أندية"), add(d.messages, "رسائل"),
      add(d.registrations, "طلبات تسجيل"), add(d.transactions, "معاملات دفع"), add(d.aiChats, "محادثات المساعد"),
      add(d.reviews, "تقييمات"), add(d.applications, "طلبات انضمام"), add(d.profileViews, "مشاهدات الملف"),
      add(d.uploads, "ملفات مرفقة"), add(d.declarations, "إقرارات مشفّرة")
    ].filter(Boolean);
    var extra = [];
    if (l.filesDeleted) extra.push("ملفات محلية محذوفة من القرص: " + l.filesDeleted);
    if (l.cloudDeleted) extra.push("فيديوهات سحابية (Cloudinary) محذوفة: " + l.cloudDeleted);
    return '<div class="log-card">' +
      '<div class="log-head"><b>🗑️ حذف حساب: ' + esc(l.targetName || l.targetUserId) + '</b>' +
        '<span class="log-time">' + esc(fmtDate(l.timestamp)) + '</span></div>' +
      '<div class="log-sub">بواسطة المشرف: ' + esc(l.adminName || l.adminId) + ' — الحساب: ' + esc(l.targetEmail || l.targetUserId) + ' (' + esc(l.targetRole || "") + ')</div>' +
      (parts.length ? '<div class="log-meta">' + parts.map(function (p) { return "<div>" + esc(p) + "</div>"; }).join("") + '</div>' : "") +
      (extra.length ? '<div class="log-extra">' + extra.map(function (p) { return "<div>" + esc(p) + "</div>"; }).join("") + '</div>' : "") +
      '</div>';
  }

  function loadAuditLog() {
    var el = document.getElementById("auditList");
    if (!el) return;
    window.API.adminLogs().then(function (res) {
      var logs = res.logs || [];
      el.innerHTML = logs.length
        ? logs.map(logCard).join("")
        : '<div class="empty">لا توجد عمليات حذف مسجلة بعد</div>';
    }).catch(function () {});
  }

  function bindActions() {
    document.querySelectorAll("[data-approve]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.dataset.approve;
        var ok = await confirmDialog("هل أنت متأكد من قبول هذا الطلب؟ سيتم تفعيل الحساب فوراً.", "قبول الطلب", false);
        if (!ok) return;
        btn.disabled = true;
        window.API.adminApprove(id).then(function (res) {
          toast(res.message || "✅ تمت الموافقة");
          loadAll();
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر القبول"), true);
          btn.disabled = false;
        });
      });
    });
    document.querySelectorAll("[data-reject]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.dataset.reject;
        var note = await promptDialog("سبب الرفض (سيظهر لمقدم الطلب):", "الملفات غير صحيحة", "اكتب سبب الرفض...");
        if (note === null) return;
        btn.disabled = true;
        window.API.adminReject(id, note).then(function (res) {
          toast(res.message || "❌ تم الرفض");
          loadAll();
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر الرفض"), true);
          btn.disabled = false;
        });
      });
    });
    document.querySelectorAll("[data-delete]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.dataset.delete;
        var ok = await confirmDialog("⚠️ تحذير نهائي: سيتم حذف حساب هذا المستخدم وكل بياناته (الملف الشخصي، الصور، الفيديوهات، الرسائل، الاشتراك، كل شيء) بشكل نهائي وغير قابل للاسترجاع. هل أنت متأكد؟", "حذف نهائي", true);
        if (!ok) return;
        btn.disabled = true;
        window.API.adminDeleteUser(id).then(function (res) {
          toast((res.message || "تم الحذف النهائي") + (res.filesDeleted ? " — ملفات محذوفة: " + res.filesDeleted : "") + (res.cloudDeleted ? " — فيديوهات سحابية: " + res.cloudDeleted : ""));
          loadAll();
          loadAuditLog();
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر الحذف"), true);
          btn.disabled = false;
        });
      });
    });
  }

  // Proof documents are protected on the server (owner + admin only).
  // Open them through an authenticated fetch so the admin can still review
  // uploaded birth certificates / medical reports / declarations.
  // Videos get an inline player modal instead — blob URLs opened in a new
  // tab do not play reliably, which made review impossible before.
  var VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|3gp|3g2|ogv)(\?|#|$)/i;
  var vidModal = null;

  function buildVideoModal() {
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(2,6,23,.82);z-index:9999;display:flex;align-items:center;justify-content:center;padding:18px;";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;max-width:min(880px,96vw);width:100%;background:#0f172a;border-radius:14px;padding:14px;box-shadow:0 24px 60px rgba(0,0,0,.5);";
    var close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText = "position:absolute;top:-14px;left:-6px;width:34px;height:34px;border-radius:50%;border:none;background:#e11d48;color:#fff;font-size:15px;font-weight:800;cursor:pointer;z-index:2;";
    var title = document.createElement("div");
    title.style.cssText = "color:#e2e8f0;font-size:13px;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:left;";
    var video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = "width:100%;max-height:72vh;border-radius:10px;background:#000;display:block;";
    box.appendChild(close); box.appendChild(title); box.appendChild(video);
    overlay.appendChild(box);
    return { overlay: overlay, video: video, title: title, close: close };
  }

  function closeVideoModal() {
    if (!vidModal) return;
    try { vidModal.video.pause(); } catch (err) {}
    vidModal.video.removeAttribute("src");
    vidModal.video.load();
    if (vidModal.blobUrl) { URL.revokeObjectURL(vidModal.blobUrl); }
    vidModal.overlay.remove();
    vidModal = null;
  }

  function openVideoModal(url) {
    closeVideoModal();
    vidModal = buildVideoModal();
    vidModal.title.textContent = decodeURIComponent(url.split("/").pop() || "");
    vidModal.close.addEventListener("click", closeVideoModal);
    vidModal.overlay.addEventListener("click", function (e) { if (e.target === vidModal.overlay) closeVideoModal(); });
    document.addEventListener("keydown", function esc(e) {
      if (e.key !== "Escape") return;
      closeVideoModal();
      document.removeEventListener("keydown", esc);
    });
    document.body.appendChild(vidModal.overlay);

    var finish = function (src, isBlob) {
      vidModal.blobUrl = isBlob ? src : null;
      vidModal.video.src = src;
      vidModal.video.play().catch(function () {});
    };
    if (url.indexOf("/uploads/") === 0) {
      // Private storage — fetch with the admin token, play from a blob URL.
      fetch(url, { credentials: "include", headers: { "Accept": "*/*" } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
        .then(function (blob) { finish(URL.createObjectURL(blob), true); })
        .catch(function () {
          closeVideoModal();
          toast("❌ لا يمكن تحميل الفيديو", true);
        });
    } else {
      // Cloudinary / public CDN URL — play directly.
      finish(url, false);
    }
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a) return;
    var url = a.getAttribute("href") || "";
    if (a.classList.contains("vid-link") || VIDEO_RE.test(url)) {
      e.preventDefault();
      openVideoModal(url);
      return;
    }
    if (url.indexOf("/uploads/") !== 0) return;
    e.preventDefault();
    fetch(url, { credentials: "include", headers: { "Accept": "*/*" } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then(function (blob) {
        var obj = URL.createObjectURL(blob);
        var w = window.open(obj, "_blank");
        if (!w) window.location.href = obj;
        setTimeout(function () { URL.revokeObjectURL(obj); }, 60000);
      })
      .catch(function () { toast("❌ لا يمكن عرض الملف", true); });
  });

  // Payment receipts are private too — load them with the admin token.
  function authedImgs(root) {
    var imgs = (root || document).querySelectorAll('img[src*="/uploads/"]');
    imgs.forEach(function (img) {
      if (img.dataset.authed) return;
      img.dataset.authed = "1";
      var src = img.getAttribute("src");
      fetch(src, { credentials: "include", headers: { "Accept": "*/*" } })
        .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
        .then(function (blob) { img.src = URL.createObjectURL(blob); })
        .catch(function () { img.style.opacity = "0.35"; });
    });
  }

  /* ======================================================================
     Subscription payments review
     ====================================================================== */

  var txStatus = "pending";
  var PAY_LABELS = {
    vodafone_cash: "💵 فودافون كاش",
    fawry: "🏧 فوري",
    kashier: "💳 كاشير (بطاقة/محفظة)",
    pending_kashier: "⏳ كاشير — بانتظار التأكيد"
  };
  var TX_STATUS = { pending: "⏳ بانتظار المراجعة", approved: "✅ مقبول", rejected: "❌ مرفوض" };

  function txBadge(status) {
    return '<span class="badge st-' + status + '">' + (TX_STATUS[status] || status) + "</span>";
  }

  function txCard(tx) {
    var shot = tx.transactionScreenshot
      ? '<img src="' + esc(tx.transactionScreenshot) + '" alt="إيصال" loading="lazy">'
      : '<span>🖼️</span>';
    var note = "";
    if (tx.status === "rejected") {
      note = '<div class="tx-note">❌ سبب الرفض: ' + esc(tx.adminNote || "الإيصال غير صحيح") + "</div>";
    }
    var actions = "";
    if (tx.status === "pending") {
      actions = '<div class="tx-actions">' +
        '<button class="btn-tx approve" data-tx-approve="' + esc(tx.id) + '">✅ قبول الدفع</button>' +
        '<button class="btn-tx reject" data-tx-reject="' + esc(tx.id) + '">❌ رفض</button>' +
        "</div>";
    }
    return '<div class="tx-card">' +
      '<div class="tx-head">' +
        '<div class="tx-ava">' + (tx.userType === "club" ? "🏟️" : "🎮") + "</div>" +
        '<div class="tx-who"><b>' + esc(tx.userName || "مستخدم") + "</b><br><span class=\"tx-email\">" + esc(tx.email) + "</span></div>" +
        '<div class="tx-amount">' + esc(tx.amount) + ' ج.م <small>/ شهر</small></div>' +
        '<span class="tx-method">' + (PAY_LABELS[tx.paymentMethod] || esc(tx.paymentMethod)) + "</span>" +
        txBadge(tx.status) +
        '<div class="reg-sub">#' + esc(tx.id) + "</div>" +
      "</div>" +
      '<div class="tx-body">' +
        '<div class="tx-shot">' + shot + "</div>" +
        '<div class="tx-detail">' +
          "<span>الرقم المرجعي: <b>" + esc(tx.referenceNumber || "—") + "</b></span>" +
          "<span>المُقدَّم في: <b>" + esc(fmtDate(tx.createdAt)) + "</b></span>" +
          "<span>المراجعة في: <b>" + (tx.reviewedAt ? esc(fmtDate(tx.reviewedAt)) : "—") + "</b></span>" +
          (tx.transactionScreenshot
            ? '<a href="' + esc(tx.transactionScreenshot) + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:800;text-decoration:none;">عرض الإيصال بحجم كامل ↗</a>'
            : "") +
        "</div>" +
      "</div>" + note + actions + "</div>";
  }

  function loadTx(status) {
    var fetchStatus = status === "all" ? "all" : status;
    window.API.adminTransactions(fetchStatus).then(function (res) {
      // One-shot admin notifications (e.g. "new manual receipt needs review").
      var notes = res.notifications || [];
      if (notes.length) {
        var last = notes[notes.length - 1];
        toast((last.title || "") + " — " + (last.message || ""));
      }
      var list = document.getElementById("txList");
      var data = res.transactions || [];
      if (!data.length) {
        list.innerHTML = '<div class="empty">لا توجد معاملات في هذه القائمة الآن</div>';
        return;
      }
      list.innerHTML = data.map(txCard).join("");
      bindTxActions();
      authedImgs(list);
    }).catch(function (err) {
      var bar = document.getElementById("errBar");
      bar.style.display = "block";
      bar.textContent = "⚠️ " + (err.message || "تعذر تحميل المعاملات");
    });
  }

  function loadTxCounts() {
    window.API.adminTransactions("all").then(function (res) {
      var counts = res.counts || {};
      ["pending", "approved", "rejected"].forEach(function (k) {
        var el = document.getElementById("tc-" + k);
        if (el) el.textContent = counts[k] || 0;
      });
      var badge = document.getElementById("txBadge");
      if (badge) badge.textContent = counts.pending || 0;
    }).catch(function () {});
  }

  function bindTxActions() {
    document.querySelectorAll("[data-tx-approve]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.dataset.txApprove;
        if (!confirm("تأكيد قبول الدفع؟ سيتم تفعيل الاشتراك 30 يوماً وفتح الردود المقفلة.")) return;
        btn.disabled = true;
        window.API.adminApproveTransaction(id).then(function (res) {
          toast(res.message || "✅ تم قبول الدفع");
          loadTxCounts();
          loadTx(txStatus);
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر القبول"), true);
          btn.disabled = false;
        });
      });
    });
    document.querySelectorAll("[data-tx-reject]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.dataset.txReject;
        var note = prompt("سبب الرفض (سيظهر للمستخدم):", "الإيصال غير صحيح أو المبلغ غير مطابق");
        if (note === null) return;
        btn.disabled = true;
        window.API.adminRejectTransaction(id, note).then(function (res) {
          toast(res.message || "❌ تم رفض الدفع");
          loadTxCounts();
          loadTx(txStatus);
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر الرفض"), true);
          btn.disabled = false;
        });
      });
    });
  }

  /* ======================================================================
     Inquiries (الاستفسارات)
     ====================================================================== */
  var inqStatus = "open";
  var INQ_SUBJECTS = {
    general: "استفسار عام", support: "دعم فني", partnership: "شراكة",
    billing: "فواتير واشتراكات", feedback: "ملاحظات", other: "أخرى"
  };

  function inqBadge(status) {
    return status === "answered"
      ? '<span class="badge st-approved">✅ تم الرد</span>'
      : '<span class="badge st-pending">⏳ بانتظار الرد</span>';
  }

  function inqCard(inq) {
    var answered = (inq.status === "answered" && inq.reply)
      ? '<div class="inq-answered"><span class="lbl">رد الإدارة' + (inq.repliedAt ? " — " + esc(fmtDate(inq.repliedAt)) : "") + '</span>' + esc(inq.reply) + '</div>'
      : "";
    var replyBox = inq.status === "answered"
      ? ""
      : '<div class="inq-reply"><textarea id="inq-reply-' + esc(inq.id) + '" placeholder="اكتب رد الإدارة هنا..."></textarea></div>' +
        '<div class="inq-actions"><button class="btn-inq" data-inq-reply="' + esc(inq.id) + '">📨 إرسال الرد</button></div>';
    return '<div class="inq-card">' +
      '<div class="inq-head">' +
        '<div class="inq-ava">💬</div>' +
        '<div class="inq-who"><b>' + esc(inq.name) + '</b><br><span class="inq-email">' + esc(inq.email) + '</span></div>' +
        inqBadge(inq.status) +
        '<div class="reg-sub">#' + esc(inq.id) + '</div>' +
      '</div>' +
      '<div class="inq-body">' +
        '<div class="inq-msg"><span class="lbl">الاستفسار (' + esc(INQ_SUBJECTS[inq.subject] || inq.subject) + ')</span>' + esc(inq.message) + '</div>' +
        answered + replyBox +
      '</div>' +
    '</div>';
  }

  function loadInquiries(status, force) {
    // Don't clobber an in-progress reply: while the admin is typing in a
    // reply box, skip the auto-refresh (otherwise the textarea is rebuilt
    // every 5s and the message vanishes).
    var composing = document.querySelector('#inqList textarea[id^="inq-reply-"]');
    if (!force && composing && document.activeElement === composing) return;

    window.API.adminInquiries(status).then(function (res) {
      var counts = res.counts || {};
      ["open", "answered"].forEach(function (k) {
        var el = document.getElementById("ic-" + k);
        if (el) el.textContent = counts[k] || 0;
      });
      var badge = document.getElementById("inqBadge");
      if (badge) badge.textContent = counts.open || 0;
      var list = document.getElementById("inqList");
      var data = res.inquiries || [];
      if (!data.length) {
        list.innerHTML = '<div class="empty">لا توجد استفسارات في هذه القائمة الآن</div>';
        return;
      }
      var drafts = {};
      list.querySelectorAll('textarea[id^="inq-reply-"]').forEach(function (ta) { drafts[ta.id] = ta.value; });
      list.innerHTML = data.map(inqCard).join("");
      Object.keys(drafts).forEach(function (id) {
        var ta = document.getElementById(id);
        if (ta) ta.value = drafts[id];
      });
      bindInqActions();
    }).catch(function (err) {
      var bar = document.getElementById("errBar");
      bar.style.display = "block";
      bar.textContent = "⚠️ " + (err.message || "تعذر تحميل الاستفسارات");
    });
  }

  function bindInqActions() {
    document.querySelectorAll("[data-inq-reply]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.dataset.inqReply;
        var ta = document.getElementById("inq-reply-" + id);
        var reply = ta ? ta.value.trim() : "";
        if (!reply) { if (ta) ta.focus(); return; }
        btn.disabled = true;
        window.API.adminReplyInquiry(id, reply).then(function () {
          toast("✅ تم إرسال الرد");
          loadInquiries(inqStatus, true);
        }).catch(function (err) {
          toast("❌ " + (err.message || "تعذر الإرسال"), true);
          btn.disabled = false;
        });
      });
    });
  }

  // Mode switch: registrations / transactions / inquiries
  document.querySelectorAll(".mode-btn").forEach(function (mb) {
    mb.addEventListener("click", function () {
      document.querySelectorAll(".mode-btn").forEach(function (x) { x.classList.remove("active"); });
      mb.classList.add("active");
      var mode = mb.dataset.mode;
      document.getElementById("regPanel").style.display = mode === "registrations" ? "" : "none";
      document.getElementById("txPanel").style.display = mode === "transactions" ? "" : "none";
      document.getElementById("inqPanel").style.display = mode === "inquiries" ? "" : "none";
      if (mode === "transactions") { loadTxCounts(); loadTx(txStatus); }
      if (mode === "inquiries") { loadInquiries(inqStatus); }
    });
  });

  document.getElementById("inqTabs").addEventListener("click", function (e) {
    var tab = e.target.closest(".tab");
    if (!tab) return;
    document.querySelectorAll("#inqTabs .tab").forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    inqStatus = tab.dataset.status;
    loadInquiries(inqStatus);
  });

  document.getElementById("txTabs").addEventListener("click", function (e) {
    var tab = e.target.closest(".tab");
    if (!tab) return;
    document.querySelectorAll("#txTabs .tab").forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    txStatus = tab.dataset.status;
    loadTx(txStatus);
  });

  // Tab switching
  document.getElementById("tabs").addEventListener("click", function (e) {
    var tab = e.target.closest(".tab");
    if (!tab) return;
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    currentStatus = tab.dataset.status;
    loadAll();
  });

  // Logout
  var lo = document.getElementById("logoutBtn");
  if (lo) lo.addEventListener("click", function () {
    window.API.logout();
    window.location.href = "Sign/Sign_In.html";
  });

  // Guard: must be signed in as admin
  (function init() {
    if (!window.API.token()) { window.location.href = "Sign/Sign_In.html"; return; }
    window.API.getMe().then(function (me) {
      if (!me.user || me.user.role !== "admin") {
        window.location.href = "index.html";
        return;
      }
      document.getElementById("adminName").textContent = me.user.name || "Admin";
      var sl = document.getElementById("navShortlist");
      if (sl) sl.style.display = "none";
      var np = document.getElementById("navProfile");
      if (np) np.href = "admin.html";
      loadAll();
      loadAuditLog();
      loadTxCounts();
      setInterval(function () {
        loadAll();
        loadTxCounts();
        if (document.getElementById("inqPanel").style.display !== "none") loadInquiries(inqStatus);
        else window.API.adminInquiries("all").then(function (r) {
          var b = document.getElementById("inqBadge");
          if (b && r.counts) b.textContent = r.counts.open || 0;
        }).catch(function () {});
      }, 5000);
    }).catch(function () {
      window.location.href = "Sign/Sign_In.html";
    });
  })();
})();