import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` so the production build works when opened from the filesystem too.
export default defineConfig({
  plugins: [react()],
  base: './',
});
