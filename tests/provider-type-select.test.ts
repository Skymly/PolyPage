// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ensureSelectOption } from '../src/options/providerTypeSelect';

describe('ensureSelectOption (M-56)', () => {
  it('adds an option for an unknown provider type', () => {
    const select = document.createElement('select');
    const known = document.createElement('option');
    known.value = 'openai-compatible';
    known.textContent = 'openai-compatible';
    select.appendChild(known);
    ensureSelectOption(select, 'future-llm', 'future-llm（未知，保留）');
    expect([...select.options].map((o) => o.value)).toEqual(['openai-compatible', 'future-llm']);
    select.value = 'future-llm';
    expect(select.value).toBe('future-llm');
  });
});
