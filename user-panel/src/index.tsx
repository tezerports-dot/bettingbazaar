// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// --- INTELLIGENT SERVICE WORKER HANDLER ---
if ('serviceWorker' in navigator) {
  const hostname = window.location.hostname;
  const isSandbox = hostname.includes('usercontent.goog') || 
                    hostname.includes('ai.studio');
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const isHttps = window.location.protocol === 'https:';

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

        // Reload when the SW takes control (after skipWaiting)
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!refreshing) { refreshing = true; window.location.reload(); }
        });

        // Listen for SW_UPDATED message from the new SW
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data?.type === 'SW_UPDATED' && !refreshing) {
            refreshing = true;
            window.location.reload();
          }
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
