import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: `npx vite apps/web` proxies /api to the local server (start it with MOTION_DEV_ORIGIN=http://127.0.0.1:5173).
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } } },
});
