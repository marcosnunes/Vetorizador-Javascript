import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url)).slice(0, -1);

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
      name: 'copy-wasm',
      writeBundle() {
        // Copy WASM files only (Vite bundles JS modules automatically)
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
      }
    }
  ]
});
