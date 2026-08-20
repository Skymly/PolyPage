/**
 * Download one documented tessdata_fast pack and verify the pinned SHA-256
 * from src/ocr/packs.ts (fra is the smallest extra language).
 */
import { createHash } from 'node:crypto';

const PACKS = {
  fra: {
    url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/fra.traineddata',
    sha256: 'ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca',
  },
};

const id = process.argv[2] || 'fra';
const pack = PACKS[id];
if (!pack) {
  console.error('unknown pack', id);
  process.exit(2);
}
console.log('Downloading', id, pack.url);
const res = await fetch(pack.url);
if (!res.ok) throw new Error('HTTP ' + res.status);
const buf = Buffer.from(await res.arrayBuffer());
const digest = createHash('sha256').update(buf).digest('hex');
console.log('got', buf.byteLength, 'sha256', digest);
if (digest !== pack.sha256) throw new Error('hash mismatch: ' + digest);
console.log('OCR PACK LIVE CHECK PASSED', id);
