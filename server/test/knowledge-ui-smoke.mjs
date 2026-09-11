/* Headless-Chrome UI smoke test for the knowledge admin panel.
   Runs against the live server:5000. Uses the DevTools Protocol directly
   (Node 22 has a global WebSocket) — no puppeteer dependency.

   Flow:
     1. Login via HTTP, capture the httpOnly manara_token cookie.
     2. Launch headless Chrome with remote debugging.
     3. Inject the cookie via Network.setCookie.
     4. Open /admin-faq.html, assert the FAQ panel renders.
     5. Switch to the params tab, assert the reconcile controls render.
     6. Create a FAQ through the modal form, then delete it through the UI.
   Exit code 0 when all checks pass.
*/
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.MANARA_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = "admin@manara.app";
const ADMIN_PASS = "AAMzTqUix%GFxa8DYS";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9222;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (extra ? " -> " + JSON.stringify(extra).slice(0, 300) : "")); }
}

/* ---- tiny CDP client ------------------------------------------------ */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      call(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close()
    });
    ws.onerror = (e) => reject(e.message || "ws error");
    ws.onclose = () => { for (const p of pending.values()) p.rej(new Error("ws closed")); pending.clear(); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
      }
    };
  });
}

function killChrome(proc) {
  try { proc.kill(); } catch (e) {}
}

function expr(script) {
  return { expression: script, returnByValue: true, awaitPromise: true };
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kui-"));
  const proc = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + DEBUG_PORT,
    "--window-size=1400,1000",
    "about:blank"
  ], { stdio: "ignore", detached: false });
  // wait for the debug port
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/version");
      if (r.ok) return { proc, profile };
    } catch (e) {}
    await sleep(300);
  }
  throw new Error("chrome debug port never opened");
}

async function smokeReq(p, body) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await fetch(BASE + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw lastErr;
}

async function main() {
  console.log("\n=== Knowledge admin UI smoke (headless Chrome) ===\n");

  // 1. login + cookie (with a short retry: the isolated runner server is
  //    freshly booted and undici can hit a transient ECONNREFUSED right at
  //    startup on Windows even though the health probe already passed).
  //    NOTE: keep ONE variable name (`login` + `mcookie`) used everywhere after.
  const mcookie = await (async () => {
    let firstErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await smokeReq("/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASS });
        const j = await r.json();
        const setCookie = r.headers.get("set-cookie") || "";
        const tk = (setCookie.match(/manara_token=([^;]+)/) || [])[1] || j.token;
        ok("login + cookie captured", !!(tk && j.token), setCookie.slice(0, 80));
        return { token: tk, info: j };
      } catch (e) {
        firstErr = firstErr || e;
        console.warn("    [smoke] login attempt " + (i + 1) + " failed (" + (e.cause && e.cause.code) + ") — retrying");
        await new Promise((res) => setTimeout(res, 900));
      }
    }
    throw firstErr;
  })();

  // resolve admin id via /auth/me (Bearer body token works without the cookie)
  const meRes = await fetch(BASE + "/api/auth/me", {
    headers: { "Authorization": "Bearer " + mcookie.token }
  });
  const meInfo = await meRes.json();
  const adminId = meInfo.user && meInfo.user.id;
  ok("admin id resolved", !!adminId, meInfo);

  // 2. launch chrome
  let chrome;
  try { chrome = await launchChrome(); }
  catch (e) { console.error("chrome launch failed:", e.message); process.exit(1); }

  try {
    const pages = await (await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/list")).json();
    const page = pages.find((p) => p.type === "page");
    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Network.enable");

    // 3. inject httpOnly cookie for localhost
    const cookieRes = await cdp.call("Network.setCookie", {
      name: "manara_token", value: mcookie.token, url: BASE,
      path: "/", httpOnly: true, sameSite: "Lax"
    });
    ok("cookie injected", cookieRes.success === true, cookieRes);

    // 4. land on the same origin first, seed the session marker + verify cookie
    await cdp.call("Page.navigate", { url: BASE + "/" });
    await sleep(1200);
    await cdp.call("Runtime.evaluate", expr(
      "localStorage.setItem('manara_session', JSON.stringify({ id: " + JSON.stringify(adminId) + ", role: 'admin' }))"));
    const meCheck = await cdp.call("Runtime.evaluate", expr(
      "fetch('/api/auth/me').then(r => r.json())")).then((r) => r.result.value);
    ok("cookie authenticates in browser", meCheck && meCheck.user && meCheck.user.role === "admin", meCheck);

    // 5. load the panel
    await cdp.call("Page.navigate", { url: BASE + "/admin-faq.html" });
    await sleep(2200);

    const pathNow = await cdp.call("Runtime.evaluate", expr("location.pathname"));
    ok("stayed on admin-faq (no auth redirect)", pathNow.result.value === "/admin-faq.html", pathNow.result.value);

    const head = await cdp.call("Runtime.evaluate", expr(
      "document.querySelector('h1') && document.querySelector('h1').textContent"))
      .then((r) => r.result.value);
    ok("header present", typeof head === "string" && head.indexOf("لوحة المعرفة") !== -1, head);

    const adminName = await cdp.call("Runtime.evaluate", expr(
      "document.getElementById('adminName').textContent")).then((r) => r.result.value);
    ok("admin greeting resolved", adminName && adminName.indexOf("…") === -1, adminName);

    const faqState = await cdp.call("Runtime.evaluate", expr(`({
      hasApi: !!(window.API && window.API.knowledgeFaqs),
      statsPill: !!document.querySelector('#faqStats .stat-pill'),
      cardsOrEmpty: document.querySelectorAll('#faqList .faq-card').length > 0 || !!document.querySelector('#faqList .empty'),
      errVisible: document.getElementById('errBar').style.display !== 'none'
    })`)).then((r) => r.result.value);
    ok("FAQ panel rendered (api + stats + list/empty)", faqState.hasApi && faqState.statsPill && faqState.cardsOrEmpty, faqState);
    ok("no page-level error bar", faqState.errVisible === false, faqState);

    // 5. params tab
    await cdp.call("Runtime.evaluate", expr(
      "document.querySelector('.mode-btn[data-mode=\"params\"]').click()"));
    await sleep(1500);
    const paramsState = await cdp.call("Runtime.evaluate", expr(`({
      panelVisible: document.getElementById('paramsPanel').style.display !== 'none',
      hasReconcile: !!document.getElementById('reconcileBtn'),
      hasApplyAll: !!document.getElementById('applyAllBtn'),
      hasExport: !!document.getElementById('exportBtn'),
      staleBannerPresent: !!document.getElementById('staleBanner')
    })`)).then((r) => r.result.value);
    ok("params tab renders controls", paramsState.panelVisible && paramsState.hasReconcile && paramsState.hasApplyAll && paramsState.hasExport, paramsState);

    // run a dry-run reconcile through the UI and assert the report box fills
    await cdp.call("Runtime.evaluate", expr("document.getElementById('reconcileBtn').click()"));
    await sleep(1800);
    const reportText = await cdp.call("Runtime.evaluate", expr(
      "document.getElementById('reportBox').textContent || ''")).then((r) => r.result.value);
    ok("reconcile report rendered in UI", /إضافة|تغيّر|فحص/.test(reportText), reportText.slice(0, 120));

    // 6. switch back to FAQ tab and create a FAQ through the modal
    await cdp.call("Runtime.evaluate", expr(
      "document.querySelector('.mode-btn[data-mode=\"faq\"]').click()"));
    await sleep(800);
    await cdp.call("Runtime.evaluate", expr("document.getElementById('addFaqBtn').click()"));
    await sleep(400);
    const modalOpen = await cdp.call("Runtime.evaluate", expr(
      "!!document.getElementById('faqForm')")).then((r) => r.result.value);
    ok("add modal opens", modalOpen === true);

await cdp.call("Runtime.evaluate", expr(`(function(){
      document.getElementById('f_qAr').value = 'كم سعر اشتراك اللاعب في منارة؟';
      document.getElementById('f_aAr').value = 'سعر اشتراك اللاعب 39 جنيهاً شهرياً.';
      document.getElementById('f_cat').value = 'general';
      document.getElementById('f_prio').value = '3';
      document.getElementById('faqForm').dispatchEvent(new Event('submit', { cancelable: true }));
    })()`));
    await sleep(1800);
    const created = await cdp.call("Runtime.evaluate", expr(`(async function(){
      const toast = document.getElementById('toast');
      return {
        matched: [...document.querySelectorAll('#faqList .faq-card')].some(c => c.textContent.includes('كم سعر اشتراك اللاعب')),
        toast: toast && toast.textContent,
        toastVisible: toast && toast.classList.contains('show'),
        modalStillOpen: !!document.getElementById('faqForm'),
        cardCount: document.querySelectorAll('#faqList .faq-card').length,
        errVisible: document.getElementById('errBar').style.display !== 'none'
      };
    })()`)).then((r) => r.result.value);
    ok("FAQ created through the UI modal", created.matched === true, created);

    // 7. delete it through the UI (confirm modal + submit)
    await cdp.call("Runtime.evaluate", expr(`(function(){
      const card = [...document.querySelectorAll('#faqList .faq-card')].find(c => c.textContent.includes('كم سعر اشتراك اللاعب'));
      if (card) card.querySelector('[data-act="del"]').click();
    })()`));
    await sleep(500);
    const confirmOpen = await cdp.call("Runtime.evaluate", expr(
      "!!document.querySelector('.modal-box.narrow')")).then((r) => r.result.value);
    ok("delete confirm modal opens", confirmOpen === true);
    await cdp.call("Runtime.evaluate", expr(
      "document.querySelector('.modal-box.narrow .modal-ok').click()"));
    await sleep(1800);
    const gone = await cdp.call("Runtime.evaluate", expr(
      "[...document.querySelectorAll('#faqList .faq-card')].every(c => !c.textContent.includes('كم سعر اشتراك اللاعب'))"
    )).then((r) => r.result.value);
    ok("FAQ deleted through the UI", gone === true);

    cdp.close();
  } finally {
    killChrome(chrome && chrome.proc);
  }

  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });