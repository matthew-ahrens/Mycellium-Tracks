import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths (./assets/x.js instead of /assets/x.js) - needed
  // so the built app works when Electron loads dist/index.html via the
  // file:// protocol, where absolute paths resolve from the filesystem
  // root instead of next to index.html. Harmless for the Vercel deploy
  // too, since that's served from the domain root either way.
  base: './',
})
