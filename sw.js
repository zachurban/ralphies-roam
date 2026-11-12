/* BuffPrints service worker — app shell offline + map tile cache */
const VERSION = 'rr-v16';
const SHELL = VERSION + '-shell';
const TILES = 'rr-tiles';
const SHELL_FILES = [
  'student.css', 'student-core.js', './', 'index.html', 'manifest.json', 'config.js', 'paths.geojson',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];
const TILE_HOSTS = ['arcgisonline.com'];
const MAX_TILES = 800;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.all(SHELL_FILES.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first, so explored areas keep working offline
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(
      caches.open(TILES).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) { c.put(req, res.clone()); trim(TILES, MAX_TILES); }
          return res;
        } catch (err) { return new Response('', { status: 504 }); }
      })
    );
    return;
  }

  // App shell: serve cached copy right away, refresh it in the background
  // The page and config.js: network first, so updates show on the next load
  const isConfig = url.origin === location.origin && url.pathname.endsWith('/config.js');
  if (req.mode === 'navigate' || isConfig) {
    const key = isConfig ? 'config.js' : 'index.html';
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); if (res.ok) caches.open(SHELL).then(c => c.put(key, copy)); return res; })
        .catch(() => caches.open(SHELL).then(c => c.match(key)))
    );
    return;
  }

  if (url.origin === location.origin || url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.open(SHELL).then(async c => {
        const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
        const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
        return hit || (await net) || (req.mode === 'navigate' ? c.match('index.html') : new Response('', { status: 504 }));
      })
    );
  }
});
