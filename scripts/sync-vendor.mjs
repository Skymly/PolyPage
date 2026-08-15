/**
 * Vendor sync for locally packaged pdf.js + tesseract.js (spec 3.0 §13 / 4.0 §7.1).
 *
 * Copies pinned build artifacts from node_modules into vendor/ and re-pins
 * their SHA-256 hashes in scripts/vendor-hashes.json. scripts/build.mjs
 * refuses to build when vendor files drift from the pinned hashes.
 *
 * Tessdata language packs (eng + chi_sim) are data files, not remote code.
 * They are downloaded from tesseract-ocr/tessdata_fast when missing
 * (jsDelivr CDN is a fallback for the same GitHub files):
 *
 *   npm install --save-dev pdfjs-dist@<version>
 *   npm install tesseract.js@<version>
 *   node scripts/sync-vendor.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const pdfSrc = path.join(root, 'node_modules', 'pdfjs-dist');
const tessSrc = path.join(root, 'node_modules', 'tesseract.js');
const coreSrc = path.join(root, 'node_modules', 'tesseract.js-core');

/** Official tessdata_fast; jsDelivr is the same GitHub files (CDN fallback). */
const TESSDATA_URLS = (lang) => [
  `https://github.com/tesseract-ocr/tessdata_fast/raw/main/${lang}.traineddata`,
  `https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/${lang}.traineddata`,
];
const TESSDATA_LANGS = ['eng', 'chi_sim'];
const MIN_TRAINEDDATA_BYTES = 100_000;
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';

const pdfFiles = [
  { from: path.join(pdfSrc, 'build', 'pdf.min.mjs'), to: 'pdf.min.mjs' },
  { from: path.join(pdfSrc, 'build', 'pdf.worker.min.mjs'), to: 'pdf.worker.min.mjs' },
];

function pickTesseractCore() {
  const preferred = [
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-simd.wasm.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core.wasm.js',
  ];
  for (const name of preferred) {
    if (existsSync(path.join(coreSrc, name))) return name;
  }
  throw new Error('tesseract.js-core WASM wrapper not found in node_modules');
}

async function copyToVendor(from, rel) {
  const dest = path.join(vendor, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(from, dest);
}

function curlDownload(url, dest, maxTimeSec = 600) {
  return new Promise((resolve, reject) => {
    const args = [
      '-L',
      '--fail',
      '--retry',
      '5',
      '--retry-delay',
      '2',
      '--retry-all-errors',
      '--connect-timeout',
      '20',
      '--max-time',
      String(maxTimeSec),
      '-o',
      dest,
      url,
    ];
    const child = spawn(CURL, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${CURL} exit ${code} for ${url}`));
    });
  });
}

async function download(urls, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  let lastErr;
  for (const url of urls) {
    try {
      console.log(`  downloading ${url}`);
      await curlDownload(url, dest);
      const size = (await stat(dest)).size;
      if (size < MIN_TRAINEDDATA_BYTES) {
        throw new Error(`${url} too small (${size} bytes); refusing to keep`);
      }
      return size;
    } catch (e) {
      lastErr = e;
      console.warn(`  download failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw lastErr;
}

await mkdir(vendor, { recursive: true });

const pdfPkg = JSON.parse(await readFile(path.join(pdfSrc, 'package.json'), 'utf8'));
const tessPkg = JSON.parse(await readFile(path.join(tessSrc, 'package.json'), 'utf8'));
const coreName = pickTesseractCore();

const tessFiles = [
  { from: path.join(tessSrc, 'dist', 'tesseract.esm.min.js'), to: 'tesseract.esm.min.js' },
  { from: path.join(tessSrc, 'dist', 'worker.min.js'), to: 'tesseract-worker.min.js' },
  { from: path.join(coreSrc, coreName), to: 'tesseract-core-simd-lstm.wasm.js' },
];

const wasmSibling = path.join(coreSrc, coreName.replace(/\.wasm\.js$/, '.wasm'));
if (existsSync(wasmSibling)) {
  tessFiles.push({ from: wasmSibling, to: path.basename(wasmSibling) });
}

for (const { from, to } of [...pdfFiles, ...tessFiles]) {
  if (!existsSync(from)) throw new Error(`vendor source missing: ${from}`);
  await copyToVendor(from, to);
  console.log(`  copied ${to}`);
}

try {
  await cp(path.join(pdfSrc, 'LICENSE'), path.join(vendor, 'LICENSE'));
} catch {
  /* license file optional */
}
try {
  await cp(path.join(coreSrc, 'LICENSE'), path.join(vendor, 'tesseract.LICENSE'));
} catch {
  /* license file optional */
}

const tessdataDir = path.join(vendor, 'tessdata');
await mkdir(tessdataDir, { recursive: true });
const tessdataFiles = [];
for (const lang of TESSDATA_LANGS) {
  const rel = `tessdata/${lang}.traineddata`;
  const dest = path.join(vendor, rel);
  if (existsSync(dest)) {
    const size = (await stat(dest)).size;
    if (size < MIN_TRAINEDDATA_BYTES) {
      throw new Error(`${rel} exists but is too small (${size} bytes); delete it and re-run`);
    }
    console.log(`  tessdata ${rel} already present (${size} bytes)`);
  } else {
    const size = await download(TESSDATA_URLS(lang), dest);
    console.log(`  downloaded ${rel} (${size} bytes)`);
  }
  tessdataFiles.push(rel);
}

const hashed = [...pdfFiles.map((f) => f.to), ...tessFiles.map((f) => f.to), ...tessdataFiles];
const pinned = {
  _comment:
    'SHA-256 hashes of the pdf.js + tesseract.js vendor distribution (including tessdata_fast language packs). scripts/build.mjs refuses to build when a file changes without a matching hash update.',
  pdfjsVersion: pdfPkg.version,
  tesseractJsVersion: tessPkg.version,
  files: {},
};
for (const name of hashed) {
  const digest = createHash('sha256')
    .update(await readFile(path.join(vendor, name)))
    .digest('hex');
  pinned.files[name] = digest;
  console.log(`  ${name}: ${digest}`);
}
await writeFile(
  path.join(root, 'scripts', 'vendor-hashes.json'),
  JSON.stringify(pinned, null, 2) + '\n',
);
console.log(
  `vendor synced: pdfjs-dist ${pdfPkg.version}, tesseract.js ${tessPkg.version} (${hashed.length} files pinned)`,
);
