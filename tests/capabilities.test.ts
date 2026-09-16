import { describe, expect, it } from 'vitest';
import { defaultProvider } from '../src/shared/constants';
import type { ProviderConfig } from '../src/shared/types';
import type { TranslationProvider } from '../src/providers/provider';
import { providerCapabilities } from '../src/providers/capabilities';

function openai(): ProviderConfig {
  return { ...defaultProvider(), id: 'a', baseUrl: 'https://example.test', apiKey: 'k' };
}

function native(): ProviderConfig {
  return { ...defaultProvider(), id: 'n', type: 'native-host', baseUrl: '', hostName: 'com.skymly.polypage' };
}

function instance(
  flags: { stream?: boolean; vision?: boolean; asr?: boolean },
  cfg: ProviderConfig = openai(),
): TranslationProvider {
  const p: TranslationProvider = {
    config: cfg,
    translateTexts: async (texts) => texts,
  };
  if (flags.stream) p.translateStream = async (text) => text;
  if (flags.vision) p.translateImage = async () => '[]';
  if (flags.asr) p.transcribe = async () => ({ text: '' });
  return p;
}

describe('providerCapabilities', () => {
  it('does not treat openai-compatible method presence as vision/asr (M-34)', () => {
    expect(providerCapabilities(openai(), instance({ stream: true, vision: true, asr: true }), null)).toEqual({
      vision: false,
      asr: false,
      streaming: true,
    });
  });

  it('honors explicit openai-compatible capability flags (M-34)', () => {
    const cfg = { ...openai(), supportsVision: true, supportsAsr: true, supportsStreaming: false };
    const inst = instance({ stream: true, vision: true, asr: true }, cfg);
    expect(providerCapabilities(cfg, inst, null)).toEqual({
      vision: true,
      asr: true,
      streaming: false,
    });
  });

  it('uses gateway caps for native-host, not instance methods', () => {
    const inst = instance({ stream: true, vision: true, asr: true });
    expect(providerCapabilities(native(), inst, { protocol: 1, supportsStreaming: true, supportsVision: true })).toEqual({
      vision: false,
      asr: false,
      streaming: false,
      gatewayProbe: 'stale-protocol',
    });
    expect(
      providerCapabilities(native(), inst, {
        protocol: 2,
        supportsStreaming: true,
        supportsVision: true,
        supportsAsr: false,
      }),
    ).toEqual({ vision: true, asr: false, streaming: true, gatewayProbe: 'ok' });
  });

  it('does not treat an unprobed native-host as protocol 1 (M-04)', () => {
    const inst = instance({ stream: true, vision: true, asr: true });
    expect(providerCapabilities(native(), inst, null, false)).toEqual({
      vision: false,
      asr: false,
      streaming: false,
      gatewayProbe: 'unprobed',
    });
    expect(providerCapabilities(native(), inst, null, true)).toEqual({
      vision: false,
      asr: false,
      streaming: false,
      gatewayProbe: 'missing',
    });
  });

  it('is none when unconfigured', () => {
    expect(providerCapabilities({ ...openai(), baseUrl: '', apiKey: '' }, instance({ stream: true }), null)).toEqual({
      vision: false,
      asr: false,
      streaming: false,
    });
  });
});