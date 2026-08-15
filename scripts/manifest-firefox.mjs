/**
 * Produce dist-firefox/ from a completed Chrome/Edge dist/ by merging
 * browser_specific_settings.gecko.id (spec 4.0 §8.2 / M9).
 *
 * Chrome/Edge continue to load dist/. Firefox temporary load uses dist-firefox/.
 */
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GECKO_ID = 'polypage@skymly.com';
export const GECKO_MIN_VERSION = '121.0';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function writeFirefoxDist(
  distDir = path.join(root, 'dist'),
  outDir = path.join(root, 'dist-firefox'),
) {
  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`Chrome dist missing at ${distDir}; run scripts/build.mjs first`);
  }
  await rm(outDir, { recursive: true, force: true });
  await cp(distDir, outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
    },
  };
  // Firefox MV3 event-page form: scripts + type=module. Chrome dist keeps
  // service_worker. Same background.js bundle works in both.
  const sw = manifest.background?.service_worker;
  if (sw) {
    manifest.background = { scripts: [sw], type: 'module' };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, geckoId: GECKO_ID };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await writeFirefoxDist();
  console.log(`Firefox MV3 package ready: ${result.outDir} (gecko.id=${result.geckoId})`);
}
