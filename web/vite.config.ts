import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `vite dev`, proxy API calls to a running `custie dashboard` server
// (default port 4747). The production build is served by that same server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4747',
    },
  },
});
