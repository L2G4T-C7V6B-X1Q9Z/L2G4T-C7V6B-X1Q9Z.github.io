// =============================================================================
// gymboard — service worker (STALE-WHILE-REVALIDATE app shell)
// -----------------------------------------------------------------------------
// Why this exists: the app is a no-build static PWA (GitHub Pages). Two failure
// modes have to be balanced:
//   1) iOS/Safari cache ES modules HARD, so people get stuck on OLD code after a
//      deploy (Jacob's "tap the type, nothing happens" bug was exactly this).
//   2) The previous fix (network-FIRST + cache:'no-store') re-downloaded the WHOLE
//      app (ui.js ~180KB + data.js ~90KB + css + html) over the network on EVERY
//      load, so the loading spinner sat for ~8s on gym/mobile wifi.
//
// STALE-WHILE-REVALIDATE fixes both: serve the cached copy INSTANTLY (the spinner
// drops in milliseconds), and in the BACKGROUND fetch a fresh copy (cache:'no-store'
// so it's a real network hit, never the browser HTTP cache) to overwrite the cache
// for the NEXT load. Net result: near-instant loads after the first visit, AND a new
// deploy still reaches everyone within ONE reload (no stale-cache lock-in — the
// property the old network-first SW was protecting is preserved).
//
// SAFETY: it ONLY touches same-origin GETs (our HTML/JS/CSS). All cross-origin
// traffic — Firebase Auth/Firestore, the gstatic SDK, Spotify embeds, the
// Cloudflare Worker — passes straight through to the network, never intercepted,
// so auth and data are completely unaffected.
// =============================================================================

// Bumped v1 -> v2 so the old network-first cache bucket is dropped on activate.
const CACHE = 'gymboard-shell-v2';

// Take over as soon as installed (don't wait for every tab to close).
self.addEventListener('install', () => self.skipWaiting());

// On activate, drop any older cache buckets (incl. the v1 network-first bucket) and
// claim open clients immediately so the new strategy is live without a manual close.
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

  // Stale-while-revalidate: return the cached copy IMMEDIATELY when present, and kick
  // off a background refresh that overwrites the cache for next time. On a cache MISS
  // (first-ever visit) we await the network. cache:'no-store' on the refresh guarantees
  // a genuine network hit (not a browser-HTTP-cached stale copy), so deploys still
  // propagate. The refresh runs fire-and-forget on a cache hit; its cache.put is fast.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const fresh = fetch(req, { cache: 'no-store' })
          .then((resp) => {
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
          })
          .catch(() => cached || Response.error());
        return cached || fresh;
      })
    )
  );
});
