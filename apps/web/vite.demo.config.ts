import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Demo build (shareable single HTML page): the real UI over an in-browser fake API.
// `npm run build:demo` → this build + scripts/build-demo.mjs inlines everything into one file.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // ASCII-only output: the page renders correctly whatever encoding the viewer assumes.
  esbuild: { charset: 'ascii' },
  resolve: { alias: { 'node:crypto': path.resolve(__dirname, 'src/demo/crypto-shim.ts') } },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { input: path.resolve(__dirname, 'demo.html'), output: { inlineDynamicImports: true, format: 'iife' } },
  },
});
