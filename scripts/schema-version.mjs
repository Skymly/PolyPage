/**
 * Read SCHEMA_VERSION from src/shared/constants.ts so live-check seeds
 * cannot drift to a stale schema (M-93).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src/shared/constants.ts'), 'utf8');
const match = src.match(/export const SCHEMA_VERSION = (\d+);/);
if (!match) {
  throw new Error('SCHEMA_VERSION missing from src/shared/constants.ts');
}
export const SCHEMA_VERSION = Number(match[1]);
