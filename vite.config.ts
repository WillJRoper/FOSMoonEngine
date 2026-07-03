/**
 * Vite build/dev configuration.
 *
 * Notes:
 * - `base` is `/` for local development.
 * - CI/deploy tooling may override `base` for GitHub Pages-style deployments.
 */

import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ command }) => ({
  // Base path — '/' for local dev. The GitHub Actions deploy workflow
  // overrides this to '/engine/' when building for GitHub Pages.
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ...(command === 'serve'
          ? { 'summary-test': resolve(__dirname, 'tests/summary-test.html') }
          : {}),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
  },
}));
