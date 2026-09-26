/* Manara PWA service worker — enables install + offline app shell.
   Cache strategy:
   - Precache the core app shell (HTML/CSS/JS/icons) at install.
   - Runtime: network-first for navigations (fresh pages), stale-while-revalidate
     for static assets, cache-first for icons/fonts.
   - Never cache API responses or /uploads (privacy-sensitive). */
const VERSION = "manara-v9";
const CORE = [
  "/",
  "/index.html",
  "/subscribe.html",
  "/terms.html",
  "/privacy.html",
  "/404.html",
  "/css/tokens.css",
  "/css/style.css",
  "/css/vendor/bootstrap.min.css",
  "/js/theme.js",
  "/js/lang.js",
  "/js/api.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(CORE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // external (fonts, etc.) untouched
  if (url.pathname.startsWith("/api/")) return; // never cache API
  if (url.pathname.startsWith("/uploads/")) return; // private media

  if (event.request.mode === "navigate") {
    // Network-first for pages: fresh content when online, cached shell offline.
    // Only successful responses are cached, and each page is stored under a
    // single pathname key — query strings (?player=…, ?redirect=…) never
    // multiply cache entries.
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(new Request(url.pathname), copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((hit) =>
            hit || caches.match(url.pathname) || caches.match("/index.html")
          )
        )
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});