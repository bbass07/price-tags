// sw.js — keeps the app usable when the booth has no signal.
//
// Network-first: online you always get the current version, so an update is
// never invisible. Offline you get the last copy that loaded.

const CACHE = 'pricetags-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/ui.js', './js/store.js', './js/render.js', './js/printer.js',
  './js/ble.js', './js/frames.js', './js/bitmap.js', './js/job.js', './js/lzma.js',
  './vendor/lzma.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
