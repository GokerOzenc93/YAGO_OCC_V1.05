import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'wasm-loader',
      load(id) {
        if (id.endsWith('.wasm')) {
          return null;
        }
      }
    }
  ],
  optimizeDeps: {
    exclude: ['opencascade.js', 'replicad']
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  assetsInclude: ['**/*.wasm'],
  // Kesim işçisi (src/components/CutWorker.ts) ES modülü olarak paketlenir: OCC paketini içe aktarır.
  worker: { format: 'es' },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    hmr: {
      overlay: false
    }
  }
});
