/**
 * llm-vision engine (spec 3.0 §6.1/§6.2, P0): a multimodal LLM produces the
 * structured `[{ text, translation }]` segments in one step.
 *
 * Request construction and response parsing are pure functions so unit tests
 * can pin the wire format against the mock vision endpoint (spec 3.0 §12.1).
 */
import { ProviderError } from '../providers/provider';
import type { TranslationContext, TranslationProvider } from '../providers/provider';
import type { OcrSegment } from '../shared/types';
import { stripThinkTags } from '../shared/sanitize';
import { stripCodeFences } from '../shared/utils';
import type { ImageInput, OcrEngine } from './engine';
import type { OcrResult } from '../shared/types';

/** Structured output prompt; glossary injected like text translation. */
export function buildVisionUserPrompt(ctx: TranslationContext): string {
  const glossary = ctx.glossary && ctx.glossary.trim() !== '' ? `\n${ctx.glossary}` : '';
  return `You are an OCR + translation engine.
Extract ALL visible text fragments from this image, in reading order.
Translate every fragment from ${ctx.sourceLanguage} to ${ctx.targetLanguage}.
Respond with ONLY a JSON array, no explanations, in this exact shape:
[{"text": "original fragment", "translation": "translated fragment"}]${glossary}`;
}

/** Pure chat/completions body builder (unit-tested). */
export function buildVisionRequest(
  model: string,
  temperature: number,
  maxTokens: number,
  prompt: string,
  dataUrl: string,
): Record<string, unknown> {
  return {
    model,
    stream: false,
    temperature,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };
}

const TEXT_KEYS = ['text', 'original', 'source', 'src'];
const TRANSLATION_KEYS = ['translation', 'translated', 'target', 'dst'];

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * Parse the model reply into segments. Tolerates code fences and alternative
 * key names; throws attributed ProviderError('invalid_response') otherwise.
 */
export function parseVisionResponse(content: string): OcrSegment[] {
  const cleaned = stripCodeFences(stripThinkTags(content)).trim();
  if (cleaned === '') {
    throw new ProviderError('invalid_response', '视觉模型返回了空内容');
  }
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new ProviderError(
      'invalid_response',
      '视觉模型未返回 JSON 数组（缺少 [...] 结构）',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new ProviderError('invalid_response', '视觉模型返回的 JSON 无法解析');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ProviderError('invalid_response', '视觉模型返回的 JSON 数组为空');
  }
  const segments: OcrSegment[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const text = pickString(obj, TEXT_KEYS);
    if (text === null) continue;
    const translation = pickString(obj, TRANSLATION_KEYS) ?? '';
    segments.push({ text: text.trim(), translation: translation.trim() });
  }
  if (segments.length === 0) {
    throw new ProviderError(
      'invalid_response',
      '视觉模型返回的片段缺少 text 字段',
    );
  }
  return segments;
}

/** The P0 engine: delegates the round trip to the provider's vision method. */
export class LlmVisionEngine implements OcrEngine {
  readonly id = 'llm-vision';

  constructor(private readonly provider: TranslationProvider) {}

  async recognize(
    input: ImageInput,
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<OcrResult> {
    if (typeof this.provider.translateImage !== 'function') {
      throw new ProviderError(
        'config',
        '当前翻译服务不支持视觉翻译（translateImage 未实现）',
      );
    }
    const content = await this.provider.translateImage(input.dataUrl, ctx, signal);
    const segments = parseVisionResponse(content);
    return { engine: 'llm-vision', segments };
  }
}