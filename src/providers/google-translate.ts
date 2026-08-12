/**
 * Google Translate v2 provider (spec 2.0 §8.1, v2 simplified).
 *  - endpoint: POST {baseUrl}
 *    (default https://translation.googleapis.com/language/translate/v2)
 *  - auth: API key as ?key= query parameter (2.0 only supports API keys)
 *  - batch: { q: [...], target, source?, format: "text" }
 *  - response: { data: { translations: [{ translatedText }] } }
 */
import type { ProviderConfig } from '../shared/types';
import { toGoogleLanguage } from './langCodes';
import {
  ProviderError,
  classifyHttpStatus,
  readApiErrorMessage,
  registerProviderFactory,
  toProviderError,
  withTimeoutAndRetry,
} from './provider';
import type { TranslationContext, TranslationProvider } from './provider';

const DEFAULT_BASE_URL = 'https://translation.googleapis.com/language/translate/v2';

export class GoogleTranslateProvider implements TranslationProvider {
  constructor(public readonly config: ProviderConfig) {}

  async translateTexts(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    if (this.config.apiKey.trim() === '') {
      throw new ProviderError('config', '未配置 Google API Key');
    }
    const target = toGoogleLanguage(ctx.targetLanguage);
    if (!target) {
      throw new ProviderError('config', 'Google Translate 需要明确的目标语言');
    }
    const source = toGoogleLanguage(ctx.sourceLanguage);

    const baseUrl = (this.config.baseUrl.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}?key=${encodeURIComponent(this.config.apiKey.trim())}`;

    const body: Record<string, unknown> = {
      q: texts,
      target,
      format: 'text',
    };
    if (source) body.source = source;

    const json = await withTimeoutAndRetry(
      async (innerSignal) => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.config.headers },
            body: JSON.stringify(body),
            signal: innerSignal,
          });
        } catch (e) {
          throw toProviderError(e);
        }
        if (!res.ok) {
          const kind = classifyHttpStatus(res.status);
          const detail = await readApiErrorMessage(res);
          throw new ProviderError(
            kind,
            `Google Translate 请求失败 (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
          );
        }
        try {
          return (await res.json()) as unknown;
        } catch {
          throw new ProviderError('invalid_response', 'Google Translate 返回了非 JSON 内容');
        }
      },
      { timeoutMs: this.config.timeoutMs, signal },
    );

    const translations = (json as { data?: { translations?: { translatedText?: unknown }[] } })
      ?.data?.translations;
    if (!Array.isArray(translations)) {
      throw new ProviderError('invalid_response', 'Google Translate 响应缺少 data.translations');
    }
    const out = translations.map((t) =>
      typeof t?.translatedText === 'string' ? decodeHtmlEntities(t.translatedText) : '',
    );
    if (out.length !== texts.length || out.some((t) => t === '')) {
      throw new ProviderError(
        'invalid_response',
        `Google Translate 译文数量不匹配（期望 ${texts.length} 条，实际 ${out.length} 条）`,
      );
    }
    return out;
  }
}

/** Google v2 HTML-escapes output even for format=text. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

registerProviderFactory('google-translate', (config) => new GoogleTranslateProvider(config));