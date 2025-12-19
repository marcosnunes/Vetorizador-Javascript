import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8080,
    open: true,
    cors: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    copyPublicDir: true
  },
  publicDir: 'vetoriza',
  assetsInclude: ['**/*.wasm']
});
