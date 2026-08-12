/**
 * Azure Translator provider (spec 2.0 §8.1).
 *  - endpoint: POST {baseUrl}/translate?api-version=3.0
 *    (default baseUrl https://api.cognitive.microsofttranslator.com)
 *  - auth: Ocp-Apim-Subscription-Key + optional Ocp-Apim-Subscription-Region
 *  - batch: request body is an array of { Text } objects; response is an
 *    array of { translations: [{ text, to }] }.
 */
import type { ProviderConfig } from '../shared/types';
import { toAzureLanguage } from './langCodes';
import {
  ProviderError,
  classifyHttpStatus,
  readApiErrorMessage,
  registerProviderFactory,
  toProviderError,
  withTimeoutAndRetry,
} from './provider';
import type { TranslationContext, TranslationProvider } from './provider';

const DEFAULT_BASE_URL = 'https://api.cognitive.microsofttranslator.com';

export class AzureTranslatorProvider implements TranslationProvider {
  constructor(public readonly config: ProviderConfig) {}

  async translateTexts(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    if (this.config.apiKey.trim() === '') {
      throw new ProviderError('config', '未配置 Azure 订阅密钥（Subscription Key）');
    }
    const to = toAzureLanguage(ctx.targetLanguage);
    if (!to) {
      throw new ProviderError('config', 'Azure Translator 需要明确的目标语言');
    }
    const from = toAzureLanguage(ctx.sourceLanguage);

    const baseUrl = (this.config.baseUrl.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const params = new URLSearchParams({ 'api-version': '3.0', to });
    if (from) params.set('from', from);
    const url = `${baseUrl}/translate?${params.toString()}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': this.config.apiKey.trim(),
      ...this.config.headers,
    };
    const region = this.config.region?.trim();
    if (region) headers['Ocp-Apim-Subscription-Region'] = region;

    const json = await withTimeoutAndRetry(
      async (innerSignal) => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(texts.map((t) => ({ Text: t }))),
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
            `Azure Translator 请求失败 (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
          );
        }
        try {
          return (await res.json()) as unknown;
        } catch {
          throw new ProviderError('invalid_response', 'Azure Translator 返回了非 JSON 内容');
        }
      },
      { timeoutMs: this.config.timeoutMs, signal },
    );

    if (!Array.isArray(json)) {
      throw new ProviderError('invalid_response', 'Azure Translator 响应不是数组');
    }
    const out: string[] = [];
    for (const item of json as unknown[]) {
      const first = (item as { translations?: { text?: unknown }[] })?.translations?.[0];
      if (typeof first?.text !== 'string') {
        throw new ProviderError('invalid_response', 'Azure Translator 响应缺少 translations[0].text');
      }
      out.push(first.text);
    }
    if (out.length !== texts.length) {
      throw new ProviderError(
        'invalid_response',
        `Azure Translator 译文数量不匹配（期望 ${texts.length} 条，实际 ${out.length} 条）`,
      );
    }
    return out;
  }
}

registerProviderFactory('azure-translator', (config) => new AzureTranslatorProvider(config));