const CACHE = 'conbini-vr-v1';
const ASSETS = [
  './',
  './index.html',
  './conbini.js',
  './model.json',
  './colliders.json',
  './manifest.webmanifest',
  './icon-512.png',
  './conbini.glb',
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

// Two policies, because both failure modes hurt:
//  - entry code (conbini.js, index.html) is network-first, so a redeploy is visible
//    on the very next launch instead of one launch later;
//  - everything else (the GLB, three.js, the loader) is cache-first, so the slow
//    link is only paid once.
const NETWORK_FIRST = /(?:conbini\.js|index\.html|\/)$/;

// three.js comes from unpkg: cross-origin, but immutable-versioned. The first cold
// load costs ~30 s on a throttled link, every one after that should be free.
const CDN = /(^|\.)unpkg\.com$/;

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN.test(url.hostname)) return;
  if (!sameOrigin) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }))
    );
    return;
  }

  if (NETWORK_FIRST.test(url.pathname)) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }

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
