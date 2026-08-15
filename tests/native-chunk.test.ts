/**
 * binary.chunk client split + sha256 (spec 4.0 §6.2, §12.1).
 */
import { describe, expect, it } from 'vitest';
import {
  BINARY_CHUNK_RAW_MAX,
  assembleBinaryChunks,
  sha256Hex,
  splitBinaryChunks,
} from '../src/shared/binaryChunk';

describe('splitBinaryChunks', () => {
  it('keeps a small payload in a single chunk and round-trips', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const digest = await sha256Hex(bytes);
    const chunks = splitBinaryChunks(bytes, 'audio/webm', 't1', digest);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].total).toBe(1);
    expect(chunks[0].mime).toBe('audio/webm');
    expect(chunks[0].sha256).toBe(digest);
    expect(assembleBinaryChunks(chunks)).toEqual(bytes);
  });

  it('splits payloads larger than 512 KiB and preserves sha256', async () => {
    const bytes = new Uint8Array(BINARY_CHUNK_RAW_MAX + 64);
    bytes[0] = 7;
    bytes[bytes.length - 1] = 9;
    const digest = await sha256Hex(bytes);
    const chunks = splitBinaryChunks(bytes, 'application/octet-stream', 't2', digest);
    expect(chunks.length).toBe(2);
    expect(chunks[0].total).toBe(2);
    expect(chunks.every((c) => c.sha256 === digest)).toBe(true);
    const assembled = assembleBinaryChunks(chunks);
    expect(assembled.byteLength).toBe(bytes.byteLength);
    expect(assembled[0]).toBe(7);
    expect(assembled[assembled.length - 1]).toBe(9);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(assembled)).toBe(digest);
  });
});
