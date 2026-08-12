import { defineConfig } from 'vite';

/**
 * Vite configuration for the extension HTML pages (Popup / Options).
 *
 * The background service worker and the content script are bundled by
 * `scripts/build.mjs` through the Vite JS API in library mode, because
 * MV3 content scripts must be a single self-contained IIFE file and the
 * service worker is a single ES module file — neither can use the shared
 * chunk code-splitting that HTML entry builds produce.
 */
export default defineConfig({
  // Relative base: extension pages must not reference absolute "/assets" URLs.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: 'src/popup/popup.html',
        options: 'src/options/options.html',
      },
    },
  },
});
