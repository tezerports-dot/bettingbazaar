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
      '/api': {
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
