/* Pure unit tests for the params source of truth (server/src/paramsSource.js).
   No server, no db.json, no HTTP — drives a fake store so reconcile/apply
   behaviour (stale detection, no silent overwrite, save calls) is provable.
   Run: node test/params-source.test.js */
const ps = require("../src/paramsSource");
const km = require("../src/knowledge");
const config = require("../src/config");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  \u2713 " + name); }
  else { failed++; console.log("  \u2717 " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

function fakeStore(seed) {
  let n = 0;
  let saves = 0;
  const store = {
    platform_params: seed || [],
    nextId: (col) => {
      if (col === "platform_param") { n++; return n; }
      return -1;
    },
    save: () => { saves++; },
    _saves: () => saves
  };
  return store;
}

/* ---- scanConfig: shape + live values ----------------------------------- */
{
  const scanned = ps.scanConfig();
  ok("scanConfig returns a candidate per spec entry", scanned.length === ps.CONFIG_SPEC.length, scanned.length);
  const allValid = scanned.every((p) => km.validatePlatformParam(p).ok === true);
  ok("every scanned param validates", allValid);
  const allAuto = scanned.every((p) => p.source === "auto-config" && p.configRef);
  ok("every scanned param source=auto-config + configRef", allAuto);
  ok("billing group mapped", scanned.find((p) => p.key === "price.gamer").group === "billing");
  ok("trial group mapped", scanned.find((p) => p.key === "trial.days_club").group === "trial");
  ok("payment group mapped", scanned.find((p) => p.key === "payment.manara_wallets").group === "payment");

  const price = scanned.find((p) => p.key === "price.gamer");
  ok("gamer price mirrors config", price.value === config.PRICES.gamer, price.value);
  ok("gamer price is a real number (not undefined)", typeof price.value === "number" && price.value > 0);
  const currency = scanned.find((p) => p.key === "billing.currency");
  ok("currency mirrors config", currency.value === config.CURRENCY);
  const wallets = scanned.find((p) => p.key === "payment.manara_wallets");
  ok("wallets array typed as array", wallets.type === "array" && Array.isArray(wallets.value));
  const ocr = scanned.find((p) => p.key === "payment.ocr_enabled");
  ok("ocr enabled boolean typed", ocr.type === "boolean" && ocr.value === config.OCR_ENABLED);

  ok("scanConfig deterministic over keys", JSON.stringify(ps.scanConfig().map((p) => p.key)) === JSON.stringify(scanned.map((p) => p.key)));
}

/* ---- reconcile: added (fresh store) ------------------------------------- */
{
  const store = fakeStore();
  const report = ps.reconcileParams(store, { dryRun: false });
  ok("empty store -> every key added", report.added.length === ps.CONFIG_SPEC.length && store.platform_params.length === ps.CONFIG_SPEC.length);
  ok("no strays after fresh add", report.stale.length === 0 && report.removed.length === 0 && report.unchanged.length === 0);
  ok("ids use store.nextId", store.platform_params.every((p) => p.id === "prm_" + p.key.split(".").length || /^prm_\d+$/.test(p.id)), store.platform_params.map((p) => p.id).slice(0, 3));
  ok("save called once on apply", store._saves() === 1, store._saves());
}

/* ---- reconcile: dryRun does not mutate -------------------------------- */
{
  const store = fakeStore();
  const before = JSON.stringify(store.platform_params);
  const report = ps.reconcileParams(store, { dryRun: true });
  ok("dryRun reports additions", report.added.length === ps.CONFIG_SPEC.length);
  ok("dryRun never mutates", JSON.stringify(store.platform_params) === before);
  ok("dryRun never saves", store._saves() === 0);
}

/* ---- reconcile: value change -> stale, never overwritten --------------- */
{
  // price.club in store says 999 while config says 299 -> must be flagged stale
  const seeded = ps.scanConfig();
  const club = seeded.find((p) => p.key === "price.club");
  club.value = 999;           // simulate an outdated stored copy
  const store = fakeStore(seeded);
  const report = ps.reconcileParams(store, { dryRun: false });

  const stale = report.stale.find((s) => s.key === "price.club");
  ok("changed value reported stale", !!stale && stale.previous === 999 && stale.current === config.PRICES.club, stale);
  ok("other keys unchanged", report.unchanged.length === ps.CONFIG_SPEC.length - 1, report.unchanged.length);
  ok("stored value NOT silently overwritten", store.platform_params.find((p) => p.key === "price.club").value === 999);
  const doc = store.platform_params.find((p) => p.key === "price.club");
  ok("stale flag + timestamp set", doc.stale === true && !!doc.staleSince && doc.staleSince <= new Date().toISOString());
  ok("configValue carries the live config value", doc.configValue === config.PRICES.club);
  ok("unchanged record keeps its updatedAt", !!store.platform_params.find((p) => p.key === "price.gamer").updatedAt);
}

/* ---- reconcile: match afterwards clears staleness ----------------------- */
{
  const seeded = ps.scanConfig();
  const club = seeded.find((p) => p.key === "price.club");
  club.value = 1; // stale vs config 299
  const store = fakeStore(seeded);
  ps.reconcileParams(store, { dryRun: false });
  ok("pre: stale present", store.platform_params.find((p) => p.key === "price.club").stale === true);
  // bring it in line, reconcile again -> staleness cleared
  const clubDoc = store.platform_params.find((p) => p.key === "price.club");
  clubDoc.value = config.PRICES.club;
  const r2 = ps.reconcileParams(store, { dryRun: false });
  const updated = store.platform_params.find((p) => p.key === "price.club");
  ok("post: stale cleared on match", updated.stale === false && updated.staleSince === null);
  ok("post: configValue cleared", updated.configValue === undefined);
  ok("post: reported unchanged", r2.unchanged.indexOf("price.club") !== -1);
}

/* ---- reconcile: manual params are never touched ------------------------- */
{
  const manual = fakeStore([
    km.newPlatformParam({ key: "price.gamer", label: { ar: "سعر مخصص", en: "Custom price" }, value: 25, source: "manual" })
  ]);
  const report = ps.reconcileParams(manual, { dryRun: false });
  ok("manual param reported in manual bucket", report.manual.indexOf("price.gamer") !== -1);
  ok("manual value untouched", manual.platform_params[0].value === 25);
  ok("manual param not flagged stale", manual.platform_params[0].stale === undefined);
  ok("other auto keys still added", report.added.length === ps.CONFIG_SPEC.length - 1);
}

/* ---- reconcile: auto-config key removed from spec ----------------------- */
{
  const legacy = fakeStore([
    km.newPlatformParam({ key: "price.legacy", label: { ar: "قديم", en: "Legacy" }, value: 1, source: "auto-config", configRef: "PRICES.legacy" })
  ]);
  const report = ps.reconcileParams(legacy, { dryRun: false });
  ok("legacy key reported removed", report.removed.indexOf("price.legacy") !== -1);
  const doc = legacy.platform_params.find((p) => p.key === "price.legacy");
  ok("legacy key flagged stale", doc.stale === true && doc.configValue === null);
}

/* ---- applyConfigValue --------------------------------------------------- */
{
  // create path
  const store = fakeStore();
  const res = ps.applyConfigValue(store, "trial.days_gamer");
  ok("apply creates missing param", res.ok === true && res.created === true && res.value === config.TRIAL_DAYS_BY_TYPE.gamer, res);
  ok("created param is auto-config", store.platform_params[0].source === "auto-config" && store.platform_params[0].configRef === "TRIAL_DAYS_BY_TYPE.gamer");
  ok("create saves store", store._saves() === 1);

  // update + stale-clear path
  const seeded = ps.scanConfig();
  seeded.find((p) => p.key === "price.club").value = 700;
  const store2 = fakeStore(seeded);
  ps.reconcileParams(store2, { dryRun: false });
  ok("pre: price.club stale", store2.platform_params.find((p) => p.key === "price.club").stale === true);
  const up = ps.applyConfigValue(store2, "price.club");
  ok("apply updates value", up.ok === true && up.updated === true && up.value === config.PRICES.club);
  ok("apply records previousValue", up.previousValue === 700);
  const doc = store2.platform_params.find((p) => p.key === "price.club");
  ok("apply clears stale", doc.stale === false && doc.staleSince === null);
  ok("apply refreshes updatedAt", doc.updatedAt >= doc.createdAt);

  // manual param guarded
  const store3 = fakeStore([km.newPlatformParam({ key: "price.gamer", label: { ar: "س", en: "x" }, value: 25, source: "manual" })]);
  const guarded = ps.applyConfigValue(store3, "price.gamer");
  ok("apply refuses manual param", guarded.ok === false);

  // unknown key guarded
  ok("apply refuses unknown key", ps.applyConfigValue(store, "nope.missing").ok === false);
}

/* ---- listStale ---------------------------------------------------------- */
{
  const list = [
    km.newPlatformParam({ key: "a", label: { ar: "x" }, value: 1 }),
    km.newPlatformParam({ key: "b", label: { ar: "x" }, value: 2 })
  ];
  list[1].stale = true;
  list[1].staleSince = new Date().toISOString();
  const stale = ps.listStale(list);
  ok("listStale returns only stale", stale.length === 1 && stale[0].key === "b");
  ok("listStale safe on missing array", ps.listStale(undefined).length === 0);
}

console.log("Result: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);