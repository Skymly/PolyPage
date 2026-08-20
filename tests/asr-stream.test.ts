/**
 * ASR streaming capability probe (spec 4.2 §7.1).
 */
import { describe, expect, it } from 'vitest';
import { asrStreamingAvailable } from '../src/asr/engine';
import { providerSupportsAsrStreaming } from '../src/providers/provider';
import type { TranslationProvider } from '../src/providers/provider';
import type { ProviderConfig } from '../src/shared/types';

function fake(partial: Partial<TranslationProvider> = {}): TranslationProvider {
  const config = { id: 'x', type: 'openai-compatible' } as ProviderConfig;
  return {
    config,
    translateTexts: async () => [],
    ...partial,
  };
}

describe('asr streaming capability', () => {
  it('is off when the provider has no transcribeStream', () => {
    const p = fake({ transcribe: async () => ({ text: 'hi' }) });
    expect(providerSupportsAsrStreaming(p)).toBe(false);
    expect(asrStreamingAvailable(p, true)).toBe(false);
  });

  it('is on only when the setting and the method both exist', () => {
    const p = fake({
      transcribe: async () => ({ text: 'hi' }),
      transcribeStream: async (_i, _c, onPartial) => {
        onPartial({ text: 'partial', segments: [{ start: 0, end: 1, text: 'partial' }] });
        return { text: 'done', segments: [{ start: 0, end: 2, text: 'done' }] };
      },
    });
    expect(providerSupportsAsrStreaming(p)).toBe(true);
    expect(asrStreamingAvailable(p, true)).toBe(true);
    expect(asrStreamingAvailable(p, false)).toBe(false);
  });
});
