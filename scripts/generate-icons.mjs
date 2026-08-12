/**
 * Generates extension icons (16/32/48/128 PNG) without any external deps.
 * Design: indigo rounded square with a white speech bubble.
 * Rendered at 4x then box-downsampled for smooth edges.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [79, 70, 229, 255]; // indigo-600
const FG = [255, 255, 255, 255]; // white bubble
const TRANSPARENT = [0, 0, 0, 0];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedSquare(x, y, size, radius) {
  const r = radius;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const cx = Math.min(Math.max(x, r), size - 1 - r);
  const cy = Math.min(Math.max(y, r), size - 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x < size - r) || (y >= r && y < size - r)
    ? (x >= r && x < size - r) || (y >= r && y < size - r) || dx * dx + dy * dy <= r * r
    : false;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(x, y, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([x, y], a, b);
  const d2 = sign([x, y], b, c);
  const d3 = sign([x, y], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function render(size) {
  const s = size * 4; // supersampling factor
  const big = Buffer.alloc(s * s * 4);
  const radius = s * 0.2;
  const bubbleC = [s * 0.5, s * 0.42];
  const bubbleR = s * 0.27;
  const tail = [
    [s * 0.3, s * 0.6],
    [s * 0.52, s * 0.6],
    [s * 0.3, s * 0.82],
  ];
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let color = TRANSPARENT;
      if (inRoundedSquare(x, y, s, radius)) {
        color = BG;
        if (inCircle(x, y, bubbleC[0], bubbleC[1], bubbleR) || inTriangle(x, y, ...tail)) {
          color = FG;
        }
      }
      big.set(color, (y * s + x) * 4);
    }
  }
  // 4x4 box downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const i = ((y * 4 + dy) * s + (x * 4 + dx)) * 4;
          for (let c = 0; c < 4; c++) acc[c] += big[i + c];
        }
      }
      out.set(acc.map((v) => Math.round(v / 16)), (y * size + x) * 4);
    }
  }
  return out;
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public/icons');
await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, render(size));
  await writeFile(path.join(outDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png (${png.length} bytes)`);
}
