import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'frontend',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'frontend/index.html'),
        parent: path.resolve(__dirname, 'frontend/parent.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      },
      '/api': {
        target: 'http://localhost:3000'
      }
    }
  },
  resolve: {
    alias: {
      // Add any aliases if needed
    }
  }
});
