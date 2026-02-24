import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

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
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  assetsInclude: ['**/*.wasm'],
  plugins: [
    {
      name: 'copy-assets',
      writeBundle() {
        // Copy WASM files
        const wasmDir = resolve(__dirname, 'dist/vetoriza/pkg');
        mkdirSync(wasmDir, { recursive: true });
        copyFileSync(
          resolve(__dirname, 'vetoriza/pkg/vetoriza.js'),
          resolve(__dirname, 'dist/vetoriza/pkg/vetoriza.js')
        );
        copyFileSync(
          resolve(__dirname, 'vetoriza/pkg/vetoriza_bg.wasm'),
          resolve(__dirname, 'dist/vetoriza/pkg/vetoriza_bg.wasm')
        );
        // Copy app.js and Firebase modules
        copyFileSync(
          resolve(__dirname, 'app.js'),
          resolve(__dirname, 'dist/app.js')
        );
        copyFileSync(
          resolve(__dirname, 'firebase-config.js'),
          resolve(__dirname, 'dist/firebase-config.js')
        );
        copyFileSync(
          resolve(__dirname, 'firestore-service.js'),
          resolve(__dirname, 'dist/firestore-service.js')
        );
        copyFileSync(
          resolve(__dirname, 'offline-queue.js'),
          resolve(__dirname, 'dist/offline-queue.js')
        );
      }
    }
  ]
});
