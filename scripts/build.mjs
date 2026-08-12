/**
 * Build pipeline for the PolyPage (Web Translator) extension.
 *
 * 1. Bundle Popup + Options HTML pages (multi-entry HTML build, may code-split).
 * 2. Bundle the background service worker as a single self-contained ES module.
 * 3. Bundle the content script as a single self-contained IIFE.
 * 4. Copy static assets (manifest.json, icons, content styles) into dist/.
 *
 * The three builds are separate because MV3 content scripts cannot be ES
 * modules and cannot load shared chunks, while the service worker is a module.
 */
import { build } from 'vite';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const shared = {
  target: 'chrome116',
  sourcemap: false,
  minify: true,
};

async function buildPage(name) {
  await build({
    root,
    configFile: false,
    base: './',
    publicDir: false, // static assets are copied once by copyStatic()
    build: {
      ...shared,
      outDir: `dist/${name}`,
      emptyOutDir: false,
      rollupOptions: {
        input: { [name]: path.join(root, `src/${name}/${name}.html`) },
      },
    },
  });
  // Vite emits the HTML at <outDir>/src/<name>/<name>.html; hoist it to
  // <outDir>/<name>.html and rewrite the relative asset paths accordingly.
  const deepHtml = path.join(dist, name, 'src', name, `${name}.html`);
  if (existsSync(deepHtml)) {
    const html = (await readFile(deepHtml, 'utf8')).replace(/\.\.\/\.\.\//g, './');
    await writeFile(path.join(dist, name, `${name}.html`), html);
    await rm(path.join(dist, name, 'src'), { recursive: true, force: true });
  }
}

async function buildPages() {
  await buildPage('popup');
  await buildPage('options');
}

async function buildBackground() {
  await build({
    root,
    configFile: false,
    build: {
      ...shared,
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry: path.join(root, 'src/background/service-worker.ts'),
        formats: ['es'],
        fileName: () => 'background.js',
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });
}

async function buildContent() {
  await build({
    root,
    configFile: false,
    build: {
      ...shared,
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        name: 'PolyPageContent',
        entry: path.join(root, 'src/content/index.ts'),
        formats: ['iife'],
        fileName: () => 'content.js',
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });
}

async function copyStatic() {
  await cp(path.join(root, 'public/manifest.json'), path.join(dist, 'manifest.json'));
  await cp(path.join(root, 'public/icons'), path.join(dist, 'icons'), { recursive: true });
  await mkdir(path.join(dist, 'styles'), { recursive: true });
  await cp(path.join(root, 'src/styles/content.css'), path.join(dist, 'styles/content.css'));
}

async function verifyDist() {
  const required = [
    'manifest.json',
    'background.js',
    'content.js',
    'popup/popup.html',
    'options/options.html',
    'styles/content.css',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
  ];
  const missing = [];
  for (const rel of required) {
    const p = path.join(dist, rel);
    if (!existsSync(p)) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new Error(`dist verification failed, missing: ${missing.join(', ')}`);
  }
  // Manifest must be valid JSON and reference files that exist.
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background?.service_worker,
    manifest.content_scripts?.[0]?.js?.[0],
    manifest.content_scripts?.[0]?.css?.[0],
    manifest.action?.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean);
  for (const rel of referenced) {
    const p = path.join(dist, rel);
    if (!existsSync(p)) throw new Error(`manifest references missing file: ${rel}`);
    const s = await stat(p);
    if (s.size === 0) throw new Error(`manifest references empty file: ${rel}`);
  }
}

await rm(dist, { recursive: true, force: true });
console.log('[1/5] Building popup/options pages...');
await buildPages();
console.log('[2/5] Building background service worker...');
await buildBackground();
console.log('[3/5] Building content script...');
await buildContent();
console.log('[4/5] Copying static assets...');
await copyStatic();
console.log('[5/5] Verifying dist...');
await verifyDist();
console.log('Build complete: dist/ is ready to load as an unpacked extension.');
