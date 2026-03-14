// vite.config.ts
import { defineConfig } from "file:///home/project/node_modules/vite/dist/node/index.js";
import react from "file:///home/project/node_modules/@vitejs/plugin-react/dist/index.js";
var vite_config_default = defineConfig({
  plugins: [
    react(),
    {
      name: "wasm-loader",
      load(id) {
        if (id.endsWith(".wasm")) {
          return null;
        }
      }
    }
  ],
  optimizeDeps: {
    exclude: ["opencascade.js", "replicad"]
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: void 0
      }
    }
  },
  assetsInclude: ["**/*.wasm"],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9wcm9qZWN0XCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvaG9tZS9wcm9qZWN0L3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9ob21lL3Byb2plY3Qvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlJztcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCc7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtcbiAgICByZWFjdCgpLFxuICAgIHtcbiAgICAgIG5hbWU6ICd3YXNtLWxvYWRlcicsXG4gICAgICBsb2FkKGlkKSB7XG4gICAgICAgIGlmIChpZC5lbmRzV2l0aCgnLndhc20nKSkge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICBdLFxuICBvcHRpbWl6ZURlcHM6IHtcbiAgICBleGNsdWRlOiBbJ29wZW5jYXNjYWRlLmpzJywgJ3JlcGxpY2FkJ11cbiAgfSxcbiAgYnVpbGQ6IHtcbiAgICB0YXJnZXQ6ICdlc25leHQnLFxuICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgIG91dHB1dDoge1xuICAgICAgICBtYW51YWxDaHVua3M6IHVuZGVmaW5lZFxuICAgICAgfVxuICAgIH1cbiAgfSxcbiAgYXNzZXRzSW5jbHVkZTogWycqKi8qLndhc20nXSxcbiAgc2VydmVyOiB7XG4gICAgaGVhZGVyczoge1xuICAgICAgJ0Nyb3NzLU9yaWdpbi1PcGVuZXItUG9saWN5JzogJ3NhbWUtb3JpZ2luJyxcbiAgICAgICdDcm9zcy1PcmlnaW4tRW1iZWRkZXItUG9saWN5JzogJ3JlcXVpcmUtY29ycCdcbiAgICB9XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUF5TixTQUFTLG9CQUFvQjtBQUN0UCxPQUFPLFdBQVc7QUFFbEIsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsU0FBUztBQUFBLElBQ1AsTUFBTTtBQUFBLElBQ047QUFBQSxNQUNFLE1BQU07QUFBQSxNQUNOLEtBQUssSUFBSTtBQUNQLFlBQUksR0FBRyxTQUFTLE9BQU8sR0FBRztBQUN4QixpQkFBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLGNBQWM7QUFBQSxJQUNaLFNBQVMsQ0FBQyxrQkFBa0IsVUFBVTtBQUFBLEVBQ3hDO0FBQUEsRUFDQSxPQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixlQUFlO0FBQUEsTUFDYixRQUFRO0FBQUEsUUFDTixjQUFjO0FBQUEsTUFDaEI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsZUFBZSxDQUFDLFdBQVc7QUFBQSxFQUMzQixRQUFRO0FBQUEsSUFDTixTQUFTO0FBQUEsTUFDUCw4QkFBOEI7QUFBQSxNQUM5QixnQ0FBZ0M7QUFBQSxJQUNsQztBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
