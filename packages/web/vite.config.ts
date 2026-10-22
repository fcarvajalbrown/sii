import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  server: { proxy: { '/api': 'http://127.0.0.1:5180' } },
});
