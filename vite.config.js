import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync, cpSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url)).slice(0, -1);

export default defineConfig({
  server: {
    port: 8080,
    open: true,
    cors: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7072',
        changeOrigin: true,
        secure: false
      }
    }
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
      name: 'copy-static-assets',
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

        // Copy PDF Splitter app to keep iframe route working in dist/preview/production
        cpSync(
          resolve(__dirname, 'pdfspliter'),
          resolve(__dirname, 'dist/pdfspliter'),
          {
            recursive: true,
            filter: (sourcePath) => {
              const ignored = ['.git', '.github', '.venv', 'node_modules'];
              return !ignored.some((name) => new RegExp(`[\\\\/]${name}([\\\\/]|$)`).test(sourcePath));
            }
          }
        );

        // Copy portfolio landing page to root of dist
        copyFileSync(
          resolve(__dirname, 'portfolio.html'),
          resolve(__dirname, 'dist/portfolio.html')
        );
      }
    }
  ]
});
