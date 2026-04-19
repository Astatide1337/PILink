import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Let `fetch('/api/...')` work in dev.
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
})
