// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'fs';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      // Inject a build timestamp into the service worker so the cache name
      // changes on every deploy — users always get fresh JS without hard refresh
      name: 'inject-sw-build-id',
      closeBundle() {
        const swPath = 'dist/service-worker.js';
        try {
          const buildId = Date.now().toString(36);
          let sw = readFileSync(swPath, 'utf8');
          sw = sw.replace('__BUILD_ID__', buildId);
          writeFileSync(swPath, sw);
          console.log(`✅ SW build ID injected: ${buildId}`);
        } catch { /* SW may not exist in dev */ }
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: '/',
  server: {
    port: 5174,
    proxy: {
      '/api': {
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
      output: {
        manualChunks: {
          'three-vendor': ['three', '@react-three/fiber'],
          'framer':       ['framer-motion'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    assetsDir: 'assets',
  },
});
