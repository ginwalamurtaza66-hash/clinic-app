// Minimal, deliberately conservative service worker.
//
// This app's whole point is live, synced clinic data — so this worker does
// NOT try to cache Firestore, Firebase Auth, Google Fonts, or any other
// third-party/API request. It only caches the static "app shell" (this
// page's own HTML/icons) so the app installs properly and opens instantly
// on repeat visits, while every data request always goes straight to the
// network exactly as before.
//
// CACHE_NAME carries the app version. Bump it whenever index.html changes:
// activate() deletes every cache that isn't the current one, so a version
// bump guarantees a stale shell cannot survive an update. That matters more
// than usual here — a stale index.html served alongside a freshly stamped
// CSP hash is exactly the "blank page after deploy" failure mode.
const CACHE_NAME = 'clinic-chart-shell-v3.27.0';

// Icons are precached too: without them an offline cold start, and the
// install prompt itself, has no icon to show.
// The three vendored libraries are part of the shell now. They used to load
// from cdnjs, which this worker deliberately never cached — so offline, PDF
// export, the analytics charts and the QR code all failed silently. Same
// origin now, so they precache with everything else. The ?v= must match the
// query string in index.html or the cache entry won't be hit.
const SHELL_FILES = [
  './',
  './index.html',
  // The per-clinic Firebase config. Precached because without it the app
  // cannot boot at all — an offline cold start would show the "not set up
  // for a clinic yet" message on a correctly configured clinic. The ?v=
  // must match the <script src> in index.html or the cache entry misses.
  './clinic-config.js?v=1',
  // book.html and book.js are deliberately absent. They are the PUBLIC booking
  // page, opened once on a patient's phone; caching them would serve stale
  // slot times and holidays to the person least able to notice. The fetch
  // handler below already ignores them — it only claims '/', index.html,
  // manifest.json, /icons/ and /vendor/.
  './manifest.json',
  // Self-hosted webfonts (3.24.0). Precached because without them an offline
  // cold start had NO webfaces at all -- measured: 61 @font-face rules became
  // 0 and headings rendered ~11% narrower in a fallback serif. The .woff2
  // files carry no ?v= because their names are already content-specific;
  // fonts.css does, and it must match the <link> in index.html exactly.
  // latin-ext is NOT optional -- the rupee sign U+20B9 lives there.
  './vendor/fonts.css?v=1',
  './vendor/fonts/fraunces-400-italic-latin-ext.woff2',
  './vendor/fonts/fraunces-400-italic-latin.woff2',
  './vendor/fonts/fraunces-400-normal-latin-ext.woff2',
  './vendor/fonts/fraunces-400-normal-latin.woff2',
  './vendor/fonts/inter-400-normal-latin-ext.woff2',
  './vendor/fonts/inter-400-normal-latin.woff2',
  './vendor/fonts/jetbrains-mono-400-normal-latin-ext.woff2',
  './vendor/fonts/jetbrains-mono-400-normal-latin.woff2',
  './vendor/jspdf.umd.min.js?v=4.2.1',
  './vendor/chart.umd.min.js?v=4.5.1',
  './vendor/qrcode.min.js?v=1.0.0',
  './vendor/jsQR.min.js?v=1.4.0',
  './icons/favicon.png',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Added individually rather than with addAll: addAll rejects the entire
    // install if a single icon 404s, which would leave the app with no
    // worker at all and no visible reason why.
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})))
    ).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only ever handle same-origin GET requests for the shell itself.
  // Everything else (Firestore, Firebase Auth, cdnjs, the Gemini API, etc.) is
  // left completely untouched and goes to the network exactly as it would
  // without a service worker. Google Fonts used to be in that list; as of
  // 3.24.0 the app makes no font requests at all, and the webfaces are served
  // from /vendor/ below like any other shell asset.
  const isShellRequest =
    req.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.pathname.endsWith('/') ||
     url.pathname.endsWith('index.html') ||
     url.pathname.endsWith('manifest.json') ||
     url.pathname.includes('/icons/') ||
     url.pathname.includes('/vendor/'));

  if (!isShellRequest) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(()=>{});
        return res;
      })
      // The index.html fallback is for navigations only. Handing a cached HTML
      // page back to a <script src> request would execute nothing and fail with
      // a MIME/syntax error instead of an honest 'failed to load' — so a missed
      // vendor file is left to fail as itself.
      .catch(() => caches.match(req).then((cached) =>
        cached || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())
      ))
  );
});
