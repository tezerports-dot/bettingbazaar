// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ─── Betting Bazaar Service Worker ───────────────────────────────────────────
// Strategy:
//   Install       → Precache the whole shell (index, hashed JS/CSS, icons), so
//                   the app starts with no network from the second visit on
//   HTML pages    → Network-first with a timeout, cached shell as the fallback
//   JS/CSS assets → Cache-first with content-hashed names (safe to cache forever)
//   API calls     → Never intercepted (pass through)
//   Images        → Stale-while-revalidate
//   Google Fonts  → Stale-while-revalidate, kept across builds

// Both replaced at build by scripts/sw-precache.mjs (vite.config.ts). Unbuilt
// (dev) they stay markers and the precache list is empty.
const BUILD_ID    = '__BUILD_ID__';
const PRECACHE    = '__PRECACHE__';
const CACHE_SHELL = `bb-shell-${BUILD_ID}`;
const CACHE_ASSETS= `bb-assets-${BUILD_ID}`;
const CACHE_FONTS = 'bb-fonts-v1';

// How long a navigation waits for the network before the cached shell is
// served instead. A connection that is up but crawling would otherwise hold
// the app on a white screen for as long as the browser's own timeout.
const NAV_TIMEOUT_MS = 4000;

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

const IS_FONT_HOST = (url) =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

// ── INSTALL: precache the shell, then skip waiting so it activates ASAP ──────
// The shell itself ('/' and the hashed bundle) must all arrive, or the worker
// does not install and the previous one keeps serving. Everything else (icons,
// the logo, the manifest) is best effort: an admin upload served from
// /app-assets may be elsewhere, and one missing image must not leave the app
// with no offline copy at all.
self.addEventListener('install', (e) => {
  const list = Array.isArray(PRECACHE) ? PRECACHE : [];
  const required = list.filter(p => p === '/' || p.startsWith('/assets/'));
  const optional = list.filter(p => !required.includes(p));
  e.waitUntil((async () => {
    const [shell, assets] = await Promise.all([caches.open(CACHE_SHELL), caches.open(CACHE_ASSETS)]);
    const fetchFresh = (p) => fetch(new Request(p, { cache: 'reload' })).then(resp => {
      if (!resp.ok) throw new Error(`precache ${p}: ${resp.status}`);
      return resp;
    });
    const cacheFor = (p) => (p.startsWith('/assets/') ? assets : shell);
    await Promise.all(required.map(async p => cacheFor(p).put(p, await fetchFresh(p))));
    await Promise.allSettled(optional.map(async p => cacheFor(p).put(p, await fetchFresh(p))));
    await self.skipWaiting();
  })());
});

// ── ACTIVATE: claim all clients + purge old caches ───────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter(k => k !== CACHE_SHELL && k !== CACHE_ASSETS && k !== CACHE_FONTS);
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

  // Google Fonts — stale-while-revalidate. The stylesheet is fetched no-cors,
  // so its response is opaque (status 0); cache that too, or the fonts never
  // load offline.
  if (IS_FONT_HOST(url)) {
    e.respondWith(caches.open(CACHE_FONTS).then(async cache => {
      const hit = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp.ok || resp.type === 'opaque') cache.put(e.request, resp.clone());
        return resp;
      }).catch(() => hit || Response.error());
      return hit || fetchPromise;
    }));
    return;
  }

  // Content-hashed assets — cache forever (safe, names change on rebuild)
  if (IS_ASSET(url)) {
    e.respondWith(caches.open(CACHE_ASSETS).then(async cache => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
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

  // HTML / navigation — network first (fresh shell on deploy), cached copy when
  // the network fails or takes longer than NAV_TIMEOUT_MS. A late answer still
  // refreshes the cache for next time. Any route of the single-page app falls
  // back to the cached '/' shell, which the router then resolves.
  e.respondWith((async () => {
    const network = fetch(e.request).then(resp => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE_SHELL).then(cache => cache.put(e.request, copy));
      }
      return resp;
    });
    const fromCache = async () =>
      (await caches.match(e.request)) ||
      (e.request.mode === 'navigate' ? await caches.match('/') : undefined);
    const timeout = new Promise(resolve => setTimeout(resolve, NAV_TIMEOUT_MS));

    try {
      const first = await Promise.race([network, timeout]);
      if (first) return first;
      const cached = await fromCache();
      if (cached) {
        e.waitUntil(network.catch(() => {}));
        return cached;
      }
      return await network;
    } catch {
      const cached = await fromCache();
      return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

// ── MESSAGE: handle SKIP_WAITING from app ────────────────────────────────────
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
