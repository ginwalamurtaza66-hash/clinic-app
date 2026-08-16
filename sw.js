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
const CACHE_NAME = 'clinic-chart-shell-v3.10.1';

// Icons are precached too: without them an offline cold start, and the
// install prompt itself, has no icon to show.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
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
  // Everything else (Firestore, Firebase Auth, Google Fonts, cdnjs, the
  // Gemini API, etc.) is left completely untouched and goes to the network
  // exactly as it would without a service worker.
  const isShellRequest =
    req.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.pathname.endsWith('/') ||
     url.pathname.endsWith('index.html') ||
     url.pathname.endsWith('manifest.json') ||
     url.pathname.includes('/icons/'));

  if (!isShellRequest) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(()=>{});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
