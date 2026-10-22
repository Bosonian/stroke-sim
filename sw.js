// Offline cache for the app shell only. Map tiles, fonts and MapLibre come from the network.
const CACHE = 'stroke-sim-v14';
const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/decide.js', 'js/grid.js', 'js/hospitals.js', 'js/i18n.js', 'js/laea.js', 'js/route.js', 'js/story.js', 'js/race.js', 'js/search.js', 'js/national.js', 'js/roads.js', 'js/start.js',
  'data/hospitals.json', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // straight from the server, not the browser cache, so a new version is never stored with old files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for our own files (so updates and new data arrive), cache as fallback.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok && !url.pathname.endsWith('.bin')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }))); // versioned module URLs (?v=) match the shell files
});
