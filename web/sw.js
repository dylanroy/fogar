// The web app's service worker. Precaches the page and everything the local model needs, so an installed app opens and
// answers with no connection; caches at first use what is fetched later (the Notebook's OCR files). Never touches
// cross-origin requests: model weights live in OPFS through wllama, and every other request is the user's business.
// scripts/build-web.mjs fills in the file list and a version derived from the files, so an unchanged deploy installs nothing.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `fogar-${VERSION}`;
// The page needs cross-origin isolation for SharedArrayBuffer (wllama's threads). The server sends these; keep them
// on the copy served from the cache too.
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function withIsolation(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // One page. Serve it from the cache; the network only when there is no copy yet. A new build arrives as a new
    // worker with a new cache, on the next open after a deploy.
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('/');
      if (cached) return withIsolation(cached);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put('/', res.clone());
        return res;
      } catch {
        return new Response('Fogar needs a connection the first time it opens.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // wllama's worker carries its options in the query string; the file is the same, so match without it.
    const cached = await cache.match(req, { ignoreSearch: true });
    // A cached response carries the URL it was stored under. A worker takes its own URL from that, and wllama's
    // reads its options from the query string, so hand back a fresh response and the browser uses the request URL.
    if (cached) return cached.url === req.url ? cached : new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers });
    const res = await fetch(req);
    if (res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
    return res;
  })());
});
