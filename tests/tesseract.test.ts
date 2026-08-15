/**
 * tesseract-wasm two-step OCR (spec 4.0 §7.1, §12.1):
 * WASM stub fills text; translation is applied by the caller via translateTexts.
 */
import { describe, expect, it } from 'vitest';
import { splitOcrText, TesseractEngine } from '../src/ocr/tesseract';
import type { TessRecognizeFn } from '../src/ocr/tesseract';
import type { TranslationContext, TranslationProvider } from '../src/providers/provider';

const ctx: TranslationContext = {
  sourceLanguage: 'auto',
  targetLanguage: '简体中文',
  glossary: '',
};

const stub: TessRecognizeFn = async () => ({
  text: 'HELLO WORLD\n\n  \nSECOND LINE\n',
});

describe('splitOcrText', () => {
  it('drops empty fragments and trims lines', () => {
    expect(splitOcrText('HELLO WORLD\n\n  \nSECOND LINE\n')).toEqual(['HELLO WORLD', 'SECOND LINE']);
  });
});

describe('TesseractEngine', () => {
  it('fills text from the WASM stub and leaves translation empty', async () => {
    const engine = new TesseractEngine(stub);
    const result = await engine.recognize({ dataUrl: 'data:image/png;base64,AAA' }, ctx, new AbortController().signal);
    expect(engine.id).toBe('tesseract-wasm');
    expect(result.engine).toBe('tesseract-wasm');
    expect(result.segments).toEqual([
      { text: 'HELLO WORLD', translation: '' },
      { text: 'SECOND LINE', translation: '' },
    ]);
  });

  it('two-step: text is then translated through translateTexts', async () => {
    const engine = new TesseractEngine(stub);
    const ocr = await engine.recognize({ dataUrl: 'data:image/png;base64,AAA' }, ctx, new AbortController().signal);
    const provider: Pick<TranslationProvider, 'translateTexts'> = {
      async translateTexts(texts) {
        return texts.map((t) => (t === 'HELLO WORLD' ? '你好世界' : '第二行'));
      },
    };
    const translated = await provider.translateTexts(
      ocr.segments.map((s) => s.text),
      ctx,
      new AbortController().signal,
    );
    const segments = ocr.segments.map((s, i) => ({ text: s.text, translation: translated[i] ?? '' }));
    expect(segments).toEqual([
      { text: 'HELLO WORLD', translation: '你好世界' },
      { text: 'SECOND LINE', translation: '第二行' },
    ]);
  });
});
