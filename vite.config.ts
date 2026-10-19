import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:8080', ws: true },
      '/api': 'http://localhost:8080',
    },
  },
});
