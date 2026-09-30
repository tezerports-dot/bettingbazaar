import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Served under /merchant/ by the unified Caddy service.
  // Caddy strips the /merchant prefix; BrowserRouter uses basename="/merchant".
  base: '/merchant/',
  server: {
    port: 5175,
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
        ws: true,
      },
      '/app-assets': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/storage': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/socket.io': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    assetsDir: 'assets',
  },
});
