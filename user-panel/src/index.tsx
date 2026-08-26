// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { captureReferralCode } from './services/referralCapture';

// Grab ?ref=CODE before anything else touches the URL. A visitor who arrives on
// an invite link rarely signs up in that first second — they look around first —
// and by the time they open the bot the URL has long since changed. Capturing at
// boot is what makes the referrer's ₹25 actually land.
captureReferralCode();

// --- INTELLIGENT SERVICE WORKER HANDLER ---
// The native Android shell (Capacitor) serves this bundle from the app package
// over its own scheme. A service worker there would intercept navigations the
// WebView already resolves locally, so it is skipped entirely — the native app
// updates through the Play Store, not through a cached shell.
const isNativeShell = !!(window as any).Capacitor?.isNativePlatform?.();

// Android freezes a backgrounded app's socket, and on resume it can still
// report itself connected over a dead WebSocket — socket.io only notices when
// the server ping times out, tens of seconds later, during which the cycle
// screen shows pools and odds that stopped updating. Rebuild on every
// foreground instead of waiting for that. Registers nothing on the web.
if (isNativeShell) {
  void Promise.all([
    import('./services/nativeLifecycle'),
    import('./services/backend.service'),
  ]).then(([{ registerNativeLifecycle }, { getBackend }]) =>
    registerNativeLifecycle(() => getBackend().reconnectRealtime?.()),
  ).catch((err) => console.warn('[native] lifecycle wiring skipped:', err));

  // The bot's one-time sign-in link is the ONLY way into an account, and it
  // arrives as an Android App Link. Without this the tap lands in a browser,
  // the browser spends the token, and the installed app can never be signed
  // in to. Registered at boot, before React mounts, so a cold start launched
  // by the link routes straight to the sign-in screen.
  void import('./services/nativeDeepLink')
    .then(({ registerNativeDeepLinks }) => registerNativeDeepLinks())
    .catch((err) => console.warn('[native] deep-link wiring skipped:', err));
}

if ('serviceWorker' in navigator && !isNativeShell) {
  const hostname = window.location.hostname;
  const isSandbox = hostname.includes('usercontent.goog') ||
                    hostname.includes('ai.studio');
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const isHttps = window.location.protocol === 'https:';

  // Whether this page is ALREADY under a service worker's control, captured
  // before registering. This is the whole fix for the first-load reload:
  //
  // `activate` calls clients.claim(), which fires `controllerchange` even on a
  // page that never had a controller — a first-ever visit, a new device, or
  // anyone who cleared their storage. Reloading on that event unconditionally
  // meant every new user's first page load flashed and reloaded itself, and it
  // is the classic PWA reload-loop footgun: any condition that makes the worker
  // look new on each load turns "reload once" into "reload forever".
  //
  // A reload is only ever warranted when a NEW worker replaced one that was
  // already driving this page. No controller at registration time = nothing was
  // replaced = nothing to reload for.
  const hadController = !!navigator.serviceWorker.controller;

  // Attempt registration on all HTTPS origins or Localhost, excluding sandboxes
  if (!isSandbox && (isHttps || isLocal)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        updateViaCache: 'none',   // always check network for SW updates
      }).then(reg => {
        if (!isLocal) console.log('✅ [PWA] Service Worker Active');

        // Check for SW updates on every page load
        reg.update();

        // When a new SW is waiting — skip waiting and reload automatically
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[PWA] New version available — reloading...');
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });

        let refreshing = false;
        const reloadOnce = () => {
          if (refreshing || !hadController) return;
          refreshing = true;
          window.location.reload();
        };

        // Reload when a new SW takes control of a page an older one was driving.
        navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);

        // Listen for SW_UPDATED message from the new SW
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data?.type === 'SW_UPDATED') reloadOnce();
        });
      }).catch(err => {
        console.debug('[PWA] SW registration deferred:', err.message);
      });
    });
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error("No root element found");

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
