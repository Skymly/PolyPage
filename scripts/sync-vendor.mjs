/**
 * Vendor sync for the locally packaged pdf.js distribution (spec 3.0 §13).
 *
 * Copies the pinned pdfjs-dist build artifacts from node_modules into
 * vendor/ and re-pins their SHA-256 hashes in scripts/vendor-hashes.json.
 * scripts/build.mjs refuses to build when vendor files drift from the
 * pinned hashes, so run this script only after a deliberate pdf.js upgrade:
 *
 *   npm install --save-dev pdfjs-dist@<version>
 *   node scripts/sync-vendor.mjs
 */
import { createHash } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const vendor = path.join(root, 'vendor');

const files = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

const pkg = JSON.parse(await readFile(path.join(src, 'package.json'), 'utf8'));

for (const name of files) {
  await cp(path.join(src, 'build', name), path.join(vendor, name));
}
try {
  await cp(path.join(src, 'LICENSE'), path.join(vendor, 'LICENSE'));
} catch {
  /* license file optional */
}

const pinned = {
  _comment:
    'SHA-256 hashes of the pdf.js vendor distribution. scripts/build.mjs refuses to build when a file changes without a matching hash update.',
  pdfjsVersion: pkg.version,
  files: {},
};
for (const name of files) {
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
console.log(`vendor synced to pdfjs-dist ${pkg.version} (${files.length} files pinned)`);