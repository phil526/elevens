// ELEVENS offline cache (self-hosted build only; see src/client/install.ts).
// Pages: network first, falling back to the saved copy. Everything else (scripts, models, sounds):
// the saved copy first, fetched and saved the first time it is needed.
const CACHE = 'elevens-v1';
// v2: pages always revalidated with the server (20 Nov 2026).

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/ws') || url.pathname.endsWith('/health')) return;
  if (req.mode === 'navigate') {
    // no-cache: ask the server every time (GitHub Pages lets browsers keep a page for 10 minutes,
    // which kept showing the previous build after an update).
    e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
      if (res.redirected) return Response.redirect(res.url, 302);
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  })));
});
