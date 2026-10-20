const CACHE = 'house-vr-v3';
const ASSETS = [
  './',
  './index.html',
  './house.js',
  './model.json',
  './colliders.json',
  './manifest.webmanifest',
  './icon-512.png',
  './house.glb',
  './vendor/GLTFLoader.js',
];

self.addEventListener('install', (e) => {
  // allSettled, not addAll: one slow asset must not abort the whole install and
  // leave the app permanently uncached.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate. This was network-first, which meant every launch waited
// out the (very slow) link even with a perfect copy already in the cache - the
// cache only ever acted as an offline fallback. Now a cached response is served
// immediately and the network copy quietly replaces it, so the second launch
// paints at once while a redeploy still propagates.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || network;
    })
  );
});
