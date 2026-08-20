/**
 * llm-vision engine tests (spec 3.0 §6.2, §12.1): request construction
 * (image_url payload, structured prompt, glossary injection) and response
 * parsing including malformed-JSON attribution.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/providers/provider';
import type { TranslationProvider } from '../src/providers/provider';
import {
  LlmVisionEngine,
  buildVisionRequest,
  buildVisionUserPrompt,
  parseVisionResponse,
} from '../src/ocr/llm-vision';

const ctx = {
  sourceLanguage: 'auto',
  targetLanguage: '简体中文',
  glossary: 'Glossary — always use these translations:\nPolyPage = PolyPage',
};

describe('buildVisionUserPrompt', () => {
  it('asks for a strict JSON array of text/translation pairs', () => {
    const prompt = buildVisionUserPrompt(ctx);
    expect(prompt).toContain('"text"');
    expect(prompt).toContain('"translation"');
    expect(prompt).toContain('ONLY a JSON array');
  });

  it('injects the glossary like text translation does', () => {
    const prompt = buildVisionUserPrompt(ctx);
    expect(prompt).toContain('PolyPage = PolyPage');
    const noGlossary = buildVisionUserPrompt({ ...ctx, glossary: '' });
    expect(noGlossary).not.toContain('Glossary');
  });

  it('carries the language pair', () => {
    const prompt = buildVisionUserPrompt({ ...ctx, sourceLanguage: 'English', targetLanguage: '中文' });
    expect(prompt).toContain('English');
    expect(prompt).toContain('中文');
  });
});

describe('buildVisionRequest', () => {
  it('places the data URL in an image_url content part', () => {
    const body = buildVisionRequest('model-x', 0.2, 4096, 'PROMPT', 'data:image/png;base64,AAA') as {
      model: string;
      messages: { role: string; content: unknown[] }[];
    };
    expect(body.model).toBe('model-x');
    expect(body.messages).toHaveLength(1);
    const parts = body.messages[0].content as Record<string, unknown>[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'PROMPT' });
    expect(parts[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    });
  });

  it('serializes cleanly to JSON', () => {
    const body = buildVisionRequest('m', 0.2, 4096, 'p', 'data:image/png;base64,BBB');
    const text = JSON.stringify(body);
    expect(text).toContain('image_url');
    expect(text).toContain('data:image/png;base64,BBB');
  });
});

describe('parseVisionResponse', () => {
  it('parses a clean JSON array', () => {
    const segments = parseVisionResponse(
      '[{"text":"HELLO","translation":"你好"},{"text":"WORLD","translation":"世界"}]',
    );
    expect(segments).toEqual([
      { text: 'HELLO', translation: '你好' },
      { text: 'WORLD', translation: '世界' },
    ]);
  });

  it('strips MiniMax think tags around a JSON array', () => {
    const segments = parseVisionResponse(
      '<think>planning</think>[{"text":"HELLO","translation":"你好"}]',
    );
    expect(segments).toEqual([{ text: 'HELLO', translation: '你好' }]);
  });

  it('strips code fences and surrounding prose', () => {
    const segments = parseVisionResponse(
      'Sure! Here you go:\n```json\n[{"text":"A","translation":"甲"}]\n```\nDone.',
    );
    expect(segments).toEqual([{ text: 'A', translation: '甲' }]);
  });

  it('accepts alternative key names', () => {
    const segments = parseVisionResponse('[{"original":"B","translated":"乙"}]');
    expect(segments).toEqual([{ text: 'B', translation: '乙' }]);
  });

  it('drops items without text but keeps the rest', () => {
    const segments = parseVisionResponse(
      '[{"translation":"无原文"},{"text":"C","translation":"丙"}]',
    );
    expect(segments).toEqual([{ text: 'C', translation: '丙' }]);
  });

  it('attributes malformed JSON to invalid_response', () => {
    const cases = ['', 'no json here', '[{"text": ', '[]', '[{"translation":"only"}]'];
    for (const bad of cases) {
      try {
        parseVisionResponse(bad);
        expect.unreachable(`should throw for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError);
        expect((e as ProviderError).kind).toBe('invalid_response');
      }
    }
  });
});

describe('LlmVisionEngine', () => {
  it('rejects providers without the vision capability', async () => {
    const stub = { config: {} as never, translateTexts: async () => [] } as unknown as TranslationProvider;
    const engine = new LlmVisionEngine(stub);
    await expect(
      engine.recognize({ dataUrl: 'data:x' }, ctx, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('round-trips through the provider translateImage method', async () => {
    const calls: string[] = [];
    const stub = {
      config: {} as never,
      translateTexts: async () => [],
      translateImage: async (dataUrl: string) => {
        calls.push(dataUrl);
        return '[{"text":"HI","translation":"嗨"}]';
      },
    } as unknown as TranslationProvider;
    const engine = new LlmVisionEngine(stub);
    const result = await engine.recognize(
      { dataUrl: 'data:image/png;base64,CC' },
      ctx,
      new AbortController().signal,
    );
    expect(result.engine).toBe('llm-vision');
    expect(result.segments).toEqual([{ text: 'HI', translation: '嗨' }]);
    expect(calls).toEqual(['data:image/png;base64,CC']);
  });
});