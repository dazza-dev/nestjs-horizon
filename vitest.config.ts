import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * Component tests for the dashboard. They mount the real screens against a stubbed API,
 * so a change to a listing, a filter or a button is caught here rather than in a browser.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['ui-test/**/*.test.ts'],
    globals: false,
  },
});
