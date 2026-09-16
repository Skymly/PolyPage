/**
 * tesseract-wasm two-step OCR (spec 4.0 §7.1, §12.1):
 * WASM stub fills text; translation is applied by the caller via translateTexts.
 */
import { describe, expect, it } from 'vitest';
import { splitOcrText, TesseractEngine, TessWorkerPool } from '../src/ocr/tesseract';
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

describe('TessWorkerPool (M-58)', () => {
  it('reuses one worker for the same language', async () => {
    let created = 0;
    let terminated = 0;
    const pool = new TessWorkerPool(async () => {
      created += 1;
      return {
        recognize: async () => ({ data: { text: 'HI', lines: [] } }),
        terminate: async () => {
          terminated += 1;
        },
      };
    });
    await pool.recognize('eng', 'data:image/png;base64,AA', new AbortController().signal);
    await pool.recognize('eng', 'data:image/png;base64,BB', new AbortController().signal);
    expect(created).toBe(1);
    expect(terminated).toBe(0);
  });

  it('aborts an in-flight recognize and does not return its text', async () => {
    let release!: () => void;
    let started!: () => void;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pool = new TessWorkerPool(async () => ({
      recognize: () => {
        started();
        return new Promise((resolve) => {
          release = () => resolve({ data: { text: 'LATE', lines: [] } });
        });
      },
      terminate: async () => {},
    }));
    const ac = new AbortController();
    const pending = pool.recognize('eng', 'data:image/png;base64,AA', ac.signal);
    await startedAt;
    ac.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    release();
  });
});
