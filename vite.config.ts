import { defineConfig } from 'vite';

// The client is a static build. During development `/ws` is proxied to the
// game server so a second browser on the LAN can join through the Vite port.
export default defineConfig({
  base: './',
  server: {
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
