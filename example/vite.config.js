import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    open: true,
  },
  // Node polyfills needed for eciesjs Buffer usage in the SDK
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  define: {
    'global': 'globalThis',
  },
});
