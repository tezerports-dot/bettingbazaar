// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { stampServiceWorker } from './scripts/sw-precache.mjs';

export default defineConfig({
  plugins: [
    react(),
    {
      // Stamp the service worker with the shell it precaches and a build id
      // hashed from those bytes (scripts/sw-precache.mjs). A changed bundle
      // changes the worker, so installed clients pick up the new build.
      name: 'stamp-service-worker',
      closeBundle() {
        const stamped = stampServiceWorker(path.resolve(import.meta.dirname, 'dist'));
        if (stamped) console.log(`✅ SW build ${stamped.id}: ${stamped.list.length} files precached`);
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  base: '/',
  server: {
    // 5173 (vite's own default), not 5174 — the ADMIN panel declares 5174, and
    // two panels claiming one port means whichever starts second silently gets
    // a different one and every note about "the panel on 5174" is wrong half
    // the time. One owner per value, applied to a port (§2).
    port: 5173,
    proxy: {
      // ── Mirror the Caddyfile, or dev is a different application ─────────
      // Production is ONE origin: Caddy serves the three panels and proxies
      // /api, /app-assets and /storage to the backend from the same host. The
      // dev server proxied only /api, so every branding image, app-asset
      // preview, CDM receipt and payment proof 404'd here and rendered fine in
      // production — a divergence that makes a browser pass over dev say
      // nothing about the thing that ships (§28: no path that only works on
      // one machine, pointed at the dev server instead of a script).
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/app-assets': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/storage': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // ── SECURITY: No sourcemaps in production ───────────────────────────────
    // true  → .map files shipped to browser, DevTools shows full original source
    // false → bundle is minified/mangled; no .map files generated at all
    // 'hidden' → .map files written to disk (for Sentry/error tracking) but
    //            the bundle does NOT reference them via sourceMappingURL comment,
    //            so browsers never download them. Best of both worlds.
    // We use 'hidden' so Railway build artefacts retain maps for crash analysis
    // while the browser is completely unable to reconstruct original source.
    sourcemap: 'hidden',
    rollupOptions: {
      // Two pages: the app, and the Telegram Mini App (mini-app.html), which
      // Telegram opens on its own and which must not share the app's router.
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        miniApp: path.resolve(import.meta.dirname, 'mini-app.html'),
      },
      output: {
        // Only split chunks for packages this panel actually imports. The
        // former 'three-vendor' entry listed three/@react-three/*, which no
        // file here imports and which this panel has never declared — it
        // resolved out of the repository-root node_modules, so the build was
        // bundling a 3D library into the player app by accident. Removed with
        // the root dependency cleanup (2026-07-27).
        // Function form: Vite 8 / rolldown no longer accepts the object map
        // (it threw "manualChunks is not a function" at build). Same split as
        // before — framer-motion in its own chunk, the React runtime in a
        // shared vendor chunk — expressed as a matcher over the module id.
        manualChunks(id) {
          if (id.includes('framer-motion')) return 'framer';
          if (/node_modules\/(react|react-dom|react-router)\//.test(id)) return 'react-vendor';
        },
      },
    },
    assetsDir: 'assets',
  },
});
