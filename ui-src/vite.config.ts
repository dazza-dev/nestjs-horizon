import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

// Absolute asset paths, rewritten by the server to the real mount path. A relative one
// breaks on nested routes like /sentinel/jobs/completed.
export default defineConfig({
  plugins: [vue()],
  base: '/',
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, '..', 'ui'),
    emptyOutDir: true,
  },
});
