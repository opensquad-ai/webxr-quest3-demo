const CACHE = 'house-vr-v1';
const ASSETS = [
  './',
  './index.html',
  './house.js',
  './model.json',
  './colliders.json',
  './manifest.webmanifest',
  './icon-512.png',
  './house.glb',
  './textures/house_atlas.webp',
  './vendor/three.module.js',
  './vendor/three.core.js',
  './vendor/GLTFLoader.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: a redeployed bake must show up on the next launch, and the
// cache is only the offline fallback for the 1 MB atlas.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && new URL(e.request.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
