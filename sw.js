// Minimal, deliberately conservative service worker.
//
// This app's whole point is live, synced clinic data — so this worker does
// NOT try to cache Firestore, Firebase Auth, Google Fonts, or any other
// third-party/API request. It only caches the static "app shell" (this
// page's own HTML/icons) so the app installs properly and opens instantly
// on repeat visits, while every data request always goes straight to the
// network exactly as before.

const CACHE_NAME = 'clinic-chart-shell-v1';
const SHELL_FILES = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(()=>{})
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
    (url.pathname.endsWith('/') || url.pathname.endsWith('index.html') || url.pathname.endsWith('manifest.json'));

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
