// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// The merchant panel's service worker (owner, 2026-10-21: "Install app"). It
// exists so the browser offers to install the panel; it caches nothing. Every
// request goes to the network as it would without it: orders, money and
// sessions are never answered from a copy. Scope /merchant/ only, so it never
// touches the player app or the admin panel on the same origin.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// Present for the browsers that still ask for one before they offer install;
// it calls no respondWith, so the network answers every request.
self.addEventListener('fetch', () => {});
