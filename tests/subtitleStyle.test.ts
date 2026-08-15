/**
 * Subtitle style field application (spec 4.0 §7.3, §12.1):
 * swapSrcDst row order, position class, background on cue rows.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  cueLineOrder,
  cuePositionClass,
  cueVerticalRatio,
} from '../src/content/subtitleStyle';

describe('cueLineOrder', () => {
  it('places source above translation by default', () => {
    expect(cueLineOrder('both', false)).toEqual(['src', 'dst']);
  });

  it('places translation above source when swapSrcDst is true', () => {
    expect(cueLineOrder('both', true)).toEqual(['dst', 'src']);
  });

  it('keeps single-line bilingual modes independent of swap', () => {
    expect(cueLineOrder('src', false)).toEqual(['src']);
    expect(cueLineOrder('src', true)).toEqual(['src']);
    expect(cueLineOrder('dst', false)).toEqual(['dst']);
    expect(cueLineOrder('dst', true)).toEqual(['dst']);
  });
});

describe('cue vertical position', () => {
  it('uses the top band for position=top and the bottom band otherwise', () => {
    expect(cueVerticalRatio('top')).toBe(0.08);
    expect(cueVerticalRatio('bottom')).toBe(0.82);
    expect(cuePositionClass('top')).toBe('wt-sub-pos-top');
    expect(cuePositionClass('bottom')).toBe('wt-sub-pos-bottom');
  });
});

describe('cue row DOM', () => {
  it('applies swap order, position class and background to rows', () => {
    const box = document.createElement('div');
    box.className = `wt-sub-box ${cuePositionClass('top')}`;
    const background = 'rgba(12,34,56,.8)';
    for (const kind of cueLineOrder('both', true)) {
      const row = document.createElement('div');
      row.className = `wt-sub-row wt-sub-${kind}`;
      row.style.background = background;
      row.textContent = kind === 'src' ? 'Hello' : '你好';
      box.appendChild(row);
    }
    const rows = [...box.querySelectorAll('.wt-sub-row')];
    expect(box.classList.contains('wt-sub-pos-top')).toBe(true);
    expect(rows.map((el) => el.className)).toEqual(['wt-sub-row wt-sub-dst', 'wt-sub-row wt-sub-src']);
    expect(rows[0].textContent).toBe('你好');
    expect(rows[1].textContent).toBe('Hello');
    expect((rows[0] as HTMLElement).style.background.replace(/\s/g, '')).toBe('rgba(12,34,56,.8)');
  });
});
