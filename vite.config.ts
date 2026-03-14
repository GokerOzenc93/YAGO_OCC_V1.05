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
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});
