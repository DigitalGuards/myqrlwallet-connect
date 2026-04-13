import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  server: {
    port: 5174,
    open: true,
  },
  plugins: [
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process'],
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
    }),
  ],
  define: {
    'global': 'globalThis',
  },
});
