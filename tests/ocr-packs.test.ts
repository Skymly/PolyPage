/**
 * OCR extra language packs (spec 4.1 pillar N / 12.1): catalog, hash check,
 * failure retry.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryOcrPackStore,
  OCR_PACK_CATALOG,
  OcrPackManager,
  catalogPack,
  formatPackMegabytes,
  knownPackId,
  resolveTessLangs,
  sha256Hex,
} from '../src/ocr/packs';

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('OCR pack catalog', () => {
  it('lists the documented extra languages with size + hash + https url', () => {
    const ids = OCR_PACK_CATALOG.map((p) => p.id);
    expect(ids).toEqual(['jpn', 'kor', 'fra', 'deu']);
    for (const pack of OCR_PACK_CATALOG) {
      expect(pack.bytes).toBeGreaterThan(1000);
      expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pack.url.startsWith('https://')).toBe(true);
      expect(pack.url.endsWith(pack.id + '.traineddata')).toBe(true);
      expect(knownPackId(pack.id)).toBe(true);
    }
    expect(knownPackId('eng')).toBe(false);
    expect(catalogPack('nope')).toBeUndefined();
    expect(formatPackMegabytes(2_471_260)).toMatch(/MB/);
  });
});

function stubCatalog(id: string, sha256: string, bytes = 16) {
  return [{ id, name: id, bytes, sha256, url: 'https://example.test/' + id + '.traineddata' }];
}

describe('OcrPackManager', () => {
  it('downloads a stub pack when the hash matches and keeps it ready', async () => {
    const payload = bytesOf('stub-jpn-traineddata');
    const digest = await sha256Hex(payload);
    const store = new MemoryOcrPackStore();
    const mgr = new OcrPackManager(store, async () => payload, stubCatalog('jpn', digest, payload.byteLength));
    const pack = await mgr.download('jpn');
    expect(pack.bytes).toBe(payload.byteLength);
    expect((await mgr.status()).find((s) => s.id === 'jpn')?.status).toBe('ready');
    await mgr.remove('jpn');
    expect((await mgr.status()).find((s) => s.id === 'jpn')?.status).toBe('absent');
  });

  it('records an error on hash mismatch and succeeds after retry', async () => {
    const good = bytesOf('good-pack');
    const digest = await sha256Hex(good);
    let calls = 0;
    const store = new MemoryOcrPackStore();
    const mgr = new OcrPackManager(store, async () => {
      calls += 1;
      if (calls === 1) return bytesOf('bad-pack');
      return good;
    }, stubCatalog('fra', digest));
    await expect(mgr.download('fra')).rejects.toThrow(/hash/i);
    expect((await mgr.status()).find((s) => s.id === 'fra')?.status).toBe('error');
    const pack = await mgr.download('fra');
    expect(pack.sha256).toBe(digest);
    expect(calls).toBe(2);
  });

  it('rejects unknown pack ids', async () => {
    const mgr = new OcrPackManager(new MemoryOcrPackStore(), async () => bytesOf('x'));
    await expect(mgr.download('spa')).rejects.toThrow(/unknown/i);
  });
});

describe('resolveTessLangs', () => {
  it('always keeps bundled langs and drops missing extras', async () => {
    const resolved = await resolveTessLangs(['eng', 'chi_sim', 'jpn'], ['jpn', 'kor'], ['jpn']);
    expect(resolved.langs).toContain('eng');
    expect(resolved.langs).toContain('chi_sim');
    expect(resolved.langs).toContain('jpn');
    expect(resolved.langs).not.toContain('kor');
    expect(resolved.missing).toContain('kor');
  });
});
