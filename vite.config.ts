import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'frontend',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext'
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      }
    }
  },
  resolve: {
    alias: {
      // Add any aliases if needed
    }
  }
});
