// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// ─── Betting Bazaar Service Worker ───────────────────────────────────────────
// Strategy:
//   HTML pages    → Network-first (always get fresh shell on deploy)
//   JS/CSS assets → Cache-first with content-hashed names (safe to cache forever)
//   API calls     → Never intercepted (pass through)
//   Images        → Stale-while-revalidate

const BUILD_ID    = '__BUILD_ID__';  // replaced by build script or stays as marker
const CACHE_SHELL = `bb-shell-${BUILD_ID}`;
const CACHE_ASSETS= `bb-assets-${BUILD_ID}`;

const NEVER_CACHE = (url) =>
  url.pathname.startsWith('/api') ||
  url.pathname.startsWith('/socket.io') ||
  url.hostname.includes('railway.app') ||
  url.protocol === 'ws:' || url.protocol === 'wss:';

const IS_ASSET = (url) =>
  url.pathname.startsWith('/assets/') ||
  url.pathname.match(/\.(js|css|woff2?|ttf|otf)$/);

const IS_IMAGE = (url) =>
  url.pathname.match(/\.(png|jpg|jpeg|svg|gif|webp|ico)$/);

// ── INSTALL: skip waiting immediately so new SW activates ASAP ───────────────
self.addEventListener('install', () => self.skipWaiting());

// ── ACTIVATE: claim all clients + purge old caches ───────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter(k => k !== CACHE_SHELL && k !== CACHE_ASSETS);
    await Promise.all(stale.map(k => caches.delete(k)));
    await self.clients.claim();

    // Tell open tabs to reload ONLY when this activation actually replaced a
    // previous build — i.e. there were older caches to purge. On a first-ever
    // install there is nothing stale, nothing was replaced, and the page
    // already has the current bundle; telling it to reload there is what made
    // every new user's first visit flash and reload itself. The client guards
    // this too (see user-panel/src/index.tsx), deliberately: the reload is
    // suppressed at both ends so neither side alone can resurrect the loop.
    if (stale.length === 0) return;
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
  })());
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Never intercept API / WS calls
  if (NEVER_CACHE(url)) return;

  // Content-hashed assets — cache forever (safe, names change on rebuild)
  if (IS_ASSET(url)) {
    e.respondWith(caches.open(CACHE_ASSETS).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const resp = await fetch(e.request);
      if (resp.ok) cache.put(e.request, resp.clone());
      return resp;
    }));
    return;
  }

  // Images — stale-while-revalidate
  if (IS_IMAGE(url)) {
    e.respondWith(caches.open(CACHE_SHELL).then(async cache => {
      const hit = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp.ok) cache.put(e.request, resp.clone());
        return resp;
      }).catch(() => hit);
      return hit || fetchPromise;
    }));
    return;
  }

  // HTML / navigation — network first, cache fallback (ensures fresh shell)
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok) {
          caches.open(CACHE_SHELL).then(cache => cache.put(e.request, resp.clone()));
        }
        return resp;
      })
      .catch(async () => {
        const cached = await caches.match(e.request) || await caches.match('/');
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
  );
});

// ── MESSAGE: handle SKIP_WAITING from app ────────────────────────────────────
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
