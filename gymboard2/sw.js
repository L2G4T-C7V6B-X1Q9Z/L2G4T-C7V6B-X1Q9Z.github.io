// gymboard v2 service worker: cache-first shell, revalidated in the background.
// Firestore / auth calls are cross-origin and pass straight through.
const CACHE = 'gb2-dfb125b';
const SHELL = ['./', './index.html'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (!url.pathname.startsWith(new URL('./', location.href).pathname)) return;
  if (url.pathname.endsWith('/sw.js')) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    const refresh = fetch(new Request(req.url, { cache: 'no-cache' })).then(async (res) => {
      if (!res || !res.ok) return res;
      const fresh = res.clone();
      if (cached) {
        const [a, b] = await Promise.all([cached.clone().text(), res.clone().text()]);
        if (a !== b) { await cache.put(key, fresh); const cs = await self.clients.matchAll({ type: 'window' }); cs.forEach((c) => c.postMessage('updated')); }
      } else await cache.put(key, fresh);
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(refresh); return cached; }
    const net = await refresh;
    return net || new Response('offline', { status: 503 });
  })());
});
