// =============================================================================
// gymboard — service worker (NETWORK-FIRST app shell)
// -----------------------------------------------------------------------------
// Why this exists: the app is a no-build static PWA (GitHub Pages). Without a
// service worker, iOS/Safari cache the ES modules HARD, so people get stuck on an
// old version every time we deploy (Jacob's "tap the type, nothing happens" bug
// was exactly this — stale code). This SW makes every ONLINE load fetch the latest
// code from the network, and only falls back to the cache when truly offline. So
// once a client has this SW, every future deploy reaches them automatically.
//
// SAFETY: it ONLY touches same-origin GETs (our HTML/JS/CSS). All cross-origin
// traffic — Firebase Auth/Firestore, the gstatic SDK, Spotify embeds, the
// Cloudflare Worker — passes straight through to the network, never intercepted,
// so auth and data are completely unaffected.
// =============================================================================

const CACHE = 'gymboard-shell-v1';

// Take over as soon as installed (don't wait for every tab to close).
self.addEventListener('install', () => self.skipWaiting());

// On activate, drop any older cache buckets and claim open clients immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes / POSTs

  const url = new URL(req.url);
  // Only manage our OWN origin's assets. Let everything cross-origin (Firebase,
  // gstatic, open.spotify.com, the Worker) go to the network untouched.
  if (url.origin !== self.location.origin) return;

  // Network-first: always try the live copy; cache it for offline; on a network
  // failure (offline) serve the last-known cached copy. `cache:'no-store'` is
  // CRUCIAL — a plain fetch(req) would still hit the browser HTTP cache and could
  // serve stale code, defeating the whole point; no-store forces a real network hit.
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
