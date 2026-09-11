/* ==========================================================================
   Platform parameters — source of truth (section 2 of the plan).
   server/src/config.js holds ALL billing/payment values (env-driven). This
   module exposes them to the knowledge base through a declarative spec:

     - scanConfig()           : walks config.js via CONFIG_SPEC and produces
                                normalized platform_param candidates
                                (source:"auto-config", configRef set).
     - reconcileParams(store) : compares scanned candidates vs the store.
                                CHANGED values flag the stored record as
                                STALE — the value is never overwritten
                                silently; an explicit apply (admin/UI) does
                                that later. Matching values clear staleness.
                                Auto-config records whose key left the spec
                                are flagged removed.
     - applyConfigValue/...   : single key force-sync + stale listing.

   Design rule: model-level fields (stale / staleSince / configValue / previousValue)
   are sync flags written here directly (they are NOT user-editable form
   fields, so they stay out of knowledge model's PARAM_EDITABLE whitelist).
   ========================================================================== */

const km = require("./knowledge");
const config = require("./config");

/* Declarative mapping: what config.js exports become knowledge params.
   `get` resolves the value every call so scanConfig always reads live state. */
const CONFIG_SPEC = [
  { key: "price.gamer", group: "billing", ref: "PRICES.gamer",
    label: { ar: "سعر اللاعب الشهري (ج.م)", en: "Gamer monthly price (EGP)" },
    get: (c) => c.PRICES.gamer },
  { key: "price.club", group: "billing", ref: "PRICES.club",
    label: { ar: "سعر النادي الشهري (ج.م)", en: "Club monthly price (EGP)" },
    get: (c) => c.PRICES.club },
  { key: "billing.currency", group: "billing", ref: "CURRENCY",
    label: { ar: "عملة الأسعار", en: "Billing currency" },
    get: (c) => c.CURRENCY },
  { key: "billing.period_days", group: "billing", ref: "BILLING_DAYS",
    label: { ar: "طول دورة الاشتراك (يوم)", en: "Subscription period (days)" },
    get: (c) => c.BILLING_DAYS },
  { key: "billing.grace_days", group: "billing", ref: "GRACE_DAYS",
    label: { ar: "مهلة السماح بعد انتهاء الاشتراك (يوم)", en: "Grace period after expiry (days)" },
    get: (c) => c.GRACE_DAYS },
  { key: "billing.expiry_reminder_days", group: "billing", ref: "EXPIRY_REMINDER_DAYS",
    label: { ar: "تذكير ما قبل انتهاء الاشتراك (يوم)", en: "Expiry reminder lead (days)" },
    internal: true,
    get: (c) => c.EXPIRY_REMINDER_DAYS },

  { key: "trial.days_gamer", group: "trial", ref: "TRIAL_DAYS_BY_TYPE.gamer",
    label: { ar: "فترة التجربة المجانية للاعب (يوم)", en: "Free trial — gamer (days)" },
    get: (c) => c.TRIAL_DAYS_BY_TYPE.gamer },
  { key: "trial.days_club", group: "trial", ref: "TRIAL_DAYS_BY_TYPE.club",
    label: { ar: "فترة التجربة المجانية للنادي (يوم)", en: "Free trial — club (days)" },
    get: (c) => c.TRIAL_DAYS_BY_TYPE.club },
  { key: "trial.days_fallback", group: "trial", ref: "TRIAL_DAYS",
    label: { ar: "التجربة الاحتياطية الافتراضية (يوم)", en: "Default trial fallback (days)" },
    get: (c) => c.TRIAL_DAYS },

  { key: "payment.pending_expiry_hours", group: "payment", ref: "PENDING_EXPIRY_HOURS",
    label: { ar: "انتهاء صلاحية إيصال الدفع المعلق (ساعة)", en: "Pending receipt expiry (hours)" },
    internal: true,
    get: (c) => c.PENDING_EXPIRY_HOURS },
  { key: "payment.amount_tolerance_egp", group: "payment", ref: "AMOUNT_TOLERANCE",
    label: { ar: "التسامح المسموح في المبلغ (ج.م)", en: "Amount tolerance (EGP)" },
    internal: true,
    get: (c) => c.AMOUNT_TOLERANCE },
  { key: "payment.ocr_confidence_min", group: "payment", ref: "OCR_CONFIDENCE_MIN",
    label: { ar: "حد الثقة الأدنى لقراءة الإيصال OCR", en: "Minimum OCR confidence" },
    internal: true,
    get: (c) => c.OCR_CONFIDENCE_MIN },
  { key: "payment.ocr_enabled", group: "payment", ref: "OCR_ENABLED",
    label: { ar: "تفعيل القراءة التلقائية للإيصالات (OCR)", en: "Receipt OCR enabled" },
    internal: true,
    get: (c) => c.OCR_ENABLED },
  { key: "payment.pending_grants_access", group: "payment", ref: "PENDING_GRANTS_ACCESS",
    label: { ar: "الإيصال المعلق يمنح وصولاً مسبقاً", en: "Pending receipt grants access early" },
    internal: true,
    get: (c) => c.PENDING_GRANTS_ACCESS },
  { key: "payment.receipt_auto_approve", group: "payment", ref: "RECEIPT_AUTO_APPROVE",
    label: { ar: "الموافقة التلقائية على الإيصالات", en: "Receipt auto-approval" },
    internal: true,
    get: (c) => c.RECEIPT_AUTO_APPROVE },
  { key: "payment.manara_wallets", group: "payment", ref: "MANARA_WALLETS",
    label: { ar: "محافظ منارة الرسمية", en: "Manara official wallets" },
    get: (c) => c.MANARA_WALLETS }
];

// Live snapshot of the spec -> normalized platform_param candidates.
function scanConfig() {
  return CONFIG_SPEC.map((s) => km.newPlatformParam({
    key: s.key,
    group: s.group,
    label: s.label,
    value: s.get(config),
    source: "auto-config",
    configRef: s.ref
  }));
}

// Operational params hidden from the PUBLIC knowledge endpoint (they expose
// internal payment/OCR mechanics, not user-facing facts).
function isInternalParamKey(key) {
  return CONFIG_SPEC.some((s) => s.internal === true && s.key === key);
}

// Human-readable config reference for a key (UI display).
function configRefFor(key) {
  const s = CONFIG_SPEC.find((x) => x.key === key);
  return s ? s.ref : null;
}

/* Compare scanned candidates against the store and maintain staleness flags.
   dryRun=false mutates the store and calls store.save() once.
   Returns a report: { scannedAt, added[], stale[], unchanged[], removed[], manual[] }
   stale entries are objects { key, previous, current }. */
function reconcileParams(store, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const list = store.platform_params || (store.platform_params = []);
  const scanned = scanConfig();
  const scannedAt = new Date().toISOString();
  const seen = new Set();
  const report = {
    scannedAt, added: [], stale: [], unchanged: [], removed: [], manual: []
  };

  scanned.forEach((p) => {
    seen.add(p.key);
    const existing = km.findParamByKey(list, p.key);
    if (!existing) {
      report.added.push(p.key);
      if (!dryRun) {
        const id = typeof store.nextId === "function"
          ? "prm_" + store.nextId("platform_param")
          : p.id;
        list.push(Object.assign({}, p, { id }));
      }
      return;
    }
    // Manual params are admin-curated — reconcile never touches their value
    // CLI/flags, it only reports them.
    if (existing.source === "manual") {
      report.manual.push(p.key);
      return;
    }
    if (JSON.stringify(existing.value) === JSON.stringify(p.value)) {
      report.unchanged.push(p.key);
      if (!dryRun) {
        existing.stale = false;
        existing.staleSince = null;
        existing.configValue = undefined;
      }
      return;
    }
    report.stale.push({ key: p.key, previous: existing.value, current: p.value });
    if (!dryRun) {
      existing.stale = true;
      existing.staleSince = scannedAt;
      existing.configValue = p.value; // what config says now — not overwritten
    }
  });

  // Auto-config records whose key is no longer part of the spec -> stale.
  list
    .filter((e) => e && e.source === "auto-config" && !seen.has(e.key))
    .forEach((e) => {
      report.removed.push(e.key);
      if (!dryRun) {
        e.stale = true;
        e.staleSince = scannedAt;
        e.configValue = null;
      }
    });

  if (!dryRun && typeof store.save === "function") store.save();
  return report;
}

/* Force-sync ONE param from config (admin apply). Creates it if missing;
   clears staleness on success. Returns { ok, created|updated, key, value }. */
function applyConfigValue(store, key) {
  const spec = CONFIG_SPEC.find((s) => s.key === key);
  if (!spec) return { ok: false, error: "unknown key" };
  const list = store.platform_params || (store.platform_params = []);
  const value = spec.get(config);
  const existing = km.findParamByKey(list, key);

  if (!existing) {
    const id = typeof store.nextId === "function"
      ? "prm_" + store.nextId("platform_param")
      : null;
    const doc = km.newPlatformParam({
      key, group: spec.group, label: spec.label, value,
      source: "auto-config", configRef: spec.ref, id
    });
    list.push(doc);
    if (typeof store.save === "function") store.save();
    return { ok: true, created: true, key, value };
  }

  if (existing.source !== "auto-config") {
    return { ok: false, error: "manual param — use the update route instead" };
  }

  // Keep the previous value for audit, then bring the value in line with
  // config and clear the stale flag.
  existing.previousValue = existing.value;
  const fresh = km.updatePlatformParam(existing, { value });
  delete fresh.stale;
  fresh.stale = false;
  fresh.staleSince = null;
  fresh.configValue = undefined;
  fresh.updatedAt = new Date().toISOString();
  const idx = list.indexOf(existing);
  list[idx] = fresh;
  if (typeof store.save === "function") store.save();
  return { ok: true, updated: true, key, value, previousValue: existing.previousValue };
}

// Params currently flagged stale (out of sync with config) — the "highlight".
function listStale(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && p.stale === true);
}

module.exports = {
  CONFIG_SPEC,
  scanConfig,
  reconcileParams,
  applyConfigValue,
  listStale,
  isInternalParamKey,
  configRefFor
};