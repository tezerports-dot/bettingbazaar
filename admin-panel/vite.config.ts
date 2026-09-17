import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Served under /admin/ by the unified Caddy service.
  // Caddy strips the /admin prefix before serving files, so assets land at
  // /admin/assets/... in the browser while physically residing in dist/assets/.
  base: '/admin/',
  server: {
    port: 5174,
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
    // SECURITY: 'hidden' writes .map files for server-side crash analysis
    // but does NOT embed sourceMappingURL in the bundle — browser never sees source.
    sourcemap: 'hidden',
    assetsDir: 'assets',
  },
});
