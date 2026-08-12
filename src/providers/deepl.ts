/**
 * DeepL API provider (spec 2.0 §8.1).
 *  - endpoint: POST {baseUrl}/v2/translate (default https://api-free.deepL.com)
 *  - auth: Authorization: DeepL-Auth-Key <key>
 *  - batch: multiple texts per request
 *  - optional formality parameter.
 */
import type { ProviderConfig } from '../shared/types';
import { toDeepLLanguage } from './langCodes';
import {
  ProviderError,
  classifyHttpStatus,
  readApiErrorMessage,
  registerProviderFactory,
  toProviderError,
  withTimeoutAndRetry,
} from './provider';
import type { TranslationContext, TranslationProvider } from './provider';

const DEFAULT_BASE_URL = 'https://api-free.deepl.com';

export class DeepLProvider implements TranslationProvider {
  constructor(public readonly config: ProviderConfig) {}

  async translateTexts(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    if (this.config.apiKey.trim() === '') {
      throw new ProviderError('config', '未配置 DeepL API Key');
    }
    const target = toDeepLLanguage(ctx.targetLanguage);
    if (!target) {
      throw new ProviderError('config', 'DeepL 不支持自动检测目标语言，请设置目标语言');
    }
    const source = toDeepLLanguage(ctx.sourceLanguage);

    const baseUrl = (this.config.baseUrl.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v2/translate`;
    const body: Record<string, unknown> = {
      text: texts,
      target_lang: target,
    };
    if (source) body.source_lang = source;
    const formality = this.config.formality ?? 'default';
    if (formality !== 'default') body.formality = formality;

    const json = await withTimeoutAndRetry(
      async (innerSignal) => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `DeepL-Auth-Key ${this.config.apiKey.trim()}`,
              ...this.config.headers,
            },
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
            `DeepL 请求失败 (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
          );
        }
        try {
          return (await res.json()) as unknown;
        } catch {
          throw new ProviderError('invalid_response', 'DeepL 返回了非 JSON 内容');
        }
      },
      { timeoutMs: this.config.timeoutMs, signal },
    );

    const translations = (json as { translations?: { text?: unknown }[] })?.translations;
    if (!Array.isArray(translations)) {
      throw new ProviderError('invalid_response', 'DeepL 响应缺少 translations 数组');
    }
    const out = translations.map((t) => (typeof t?.text === 'string' ? t.text : ''));
    if (out.length !== texts.length || out.some((t) => t === '')) {
      throw new ProviderError(
        'invalid_response',
        `DeepL 译文数量不匹配（期望 ${texts.length} 条，实际 ${out.length} 条）`,
      );
    }
    return out;
  }
}

registerProviderFactory('deepl', (config) => new DeepLProvider(config));