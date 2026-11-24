import { describe, expect, it } from 'vitest';
import { bilingualPdfHtml } from '../src/viewer/pdf/htmlExport';
import { clusterPage } from '../src/viewer/pdf/segment';
import { sampleHeaders } from '../src/viewer/pdf/sections';

it('uses healthy header samples and lets the viewer retry a failed sample on demand', async () => {
  const good = { lines: [], pageHeight: 792 };
  let attempts = 0;
  const load = async (index: number) => {
    if (index === 2 && attempts++ === 0) throw new Error('damaged page handle');
    return good;
  };
  const sampled = sampleHeaders(180, load);
  expect(await sampled.signatures).toEqual(new Set());
  expect(await sampled.pages.get(1)).toBe(good);
  expect(sampled.pages.has(2)).toBe(false);
  expect(await (sampled.pages.get(2) ?? load(2))).toBe(good);
});

describe('reading table cells and finding their position on the PDF', () => {
  it('separates narrow gutters when the two prose columns have different baselines', () => {
    const items = Array.from({ length: 12 }, (_, i) => [
      { str: `Left column sentence ${i}.`, width: 216, transform: [11, 0, 0, 11, 72, 700 - i * 14] },
      { str: `Right column sentence ${i}.`, width: 210, transform: [11, 0, 0, 11, 306, 698 - i * 12] },
    ]).flat();
    const { paragraphs } = clusterPage(items);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].text).toContain('Left column sentence 11.');
    expect(paragraphs[0].text).not.toContain('Right');
    expect(paragraphs[1].bounds[0]).toBe(306);
  });

  it('uses aligned numeric columns to split compact paper table rows', () => {
    const items = [['Net', 'Top 1', 'Top 5'], ['Base A', '24.90', '6.17'], ['Large', '21.11', '5.20']].flatMap((row, y) =>
      row.map((str, x) => ({ str, width: [41, 20, 17][x], transform: [9, 0, 0, 9, [96, 156, 194][x], 712 - y * 12] })));
    expect(clusterPage(items).paragraphs.map((p) => p.text)).toEqual(items.map((i) => i.str));
  });

  it('keeps the order and bounding box of each cell in tightly spaced rows', () => {
    const items = ['Item', 'Qty', 'Price', 'Fan', '12', '9.00'].map((str, index) => ({
      str, width: 18, transform: [10, 0, 0, 10, 50 + (index % 3) * 150, 758 - Math.floor(index / 3) * 13],
    }));
    const { paragraphs } = clusterPage(items);
    expect(paragraphs.map((p) => p.text)).toEqual(['Item', 'Qty', 'Price', 'Fan', '12', '9.00']);
    expect(paragraphs[4].bounds).toEqual([200, 742.8, 218, 755]);
  });

  it('keeps a body paragraph whose text also appears as a repeating header', () => {
    const items = [770, 620].map((y) => ({ str: 'Appendix', width: 50, transform: [10, 0, 0, 10, 45, y] }));
    expect(clusterPage(items, { headerFooterSet: new Set(['appendix']) }).paragraphs).toHaveLength(1);
  });
});

describe('offline bilingual PDF snapshot', () => {
  const read = (index: number) => {
    if (index === 2) return { loaded: true, scanned: true, paragraphs: [] };
    if (index === 3) return { loaded: true, scanned: false, paragraphs: [
      { text: '<img onerror=bad>', translated: '你好 & 再见' }, { text: 'Pending', translated: null },
    ] };
    return undefined;
  };

  it('numbers pages in source order, escapes content and marks incomplete results', () => {
    const html = bilingualPdfHtml('A&B', 1, 3, read);
    expect(html.match(/<h2>第 \d 页<\/h2>/g)).toEqual(['<h2>第 1 页</h2>', '<h2>第 2 页</h2>', '<h2>第 3 页</h2>']);
    for (const text of ['A&amp;B', '未读取', '扫描页，尚未识别', '尚未翻译', '你好 &amp; 再见', '&lt;img onerror=bad&gt;']) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('<img');
  });

  it('limits a current-page export to that page and identifies its actual page number', () => {
    const html = bilingualPdfHtml('Handbook', 3, 3, read);
    expect(html).toContain('<h2>第 3 页</h2>');
    expect(html).not.toContain('<h2>第 2 页</h2>');
  });
});
