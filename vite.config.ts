import { defineConfig } from 'vite';

/**
 * Vite config consumed by Vitest (`npm test`). Production bundles are built
 * by `scripts/build.mjs` with `configFile: false` — do not put MV3 entry
 * lists here; they would drift from the script (offscreen, IIFE content, etc.).
 */
export default defineConfig({
  // Relative base: extension pages must not reference absolute "/assets" URLs
  // if anyone runs `vite build` by hand. The real page builds pass this in
  // build.mjs.
  base: './',
});
