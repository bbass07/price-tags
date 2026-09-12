// sw.js — keeps the app usable when the booth has no signal.
//
// Network-first: online you always get the current version, so an update is
// never invisible. Offline you get the last copy that loaded.
//
// "Network" has to mean the real network. GitHub Pages serves everything with
// `max-age=600`, so a plain fetch can be answered from the browser's own HTTP
// cache for ten minutes — long enough to hand back a new index.html with the
// old ui.js beside it, which is a broken app, not an old one. Every fetch here
// is therefore revalidated against the server; a 304 costs almost nothing.

const CACHE = 'pricetags-v15';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest', './home-screen.html', './landed.html',
  './js/ui.js', './js/store.js', './js/render.js', './js/printer.js',
  './js/ble.js', './js/fullscreen.js', './js/frames.js', './js/bitmap.js', './js/job.js', './js/lzma.js',
  './vendor/lzma.js',
  './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png',
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
  // Rebuilt from the URL rather than passed straight through: a navigation
  // request cannot be copied with a new cache mode, and `no-cache` is the
  // whole point — ask the server every time, accept a 304.
  const fresh = new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(
    fetch(fresh)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
