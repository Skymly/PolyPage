/**
 * Generic custom HTTP JSON translation API provider (spec §8.2).
 *
 * The user configures:
 *  - baseUrl (+ optional query api key)
 *  - method (default POST)
 *  - headers
 *  - a JSON body template with placeholders:
 *      {{texts}} {{text}} {{sourceLanguage}} {{targetLanguage}}
 *      {{model}} {{domain}} {{glossary}} {{apiKey}}
 *    {{texts}} renders as a JSON array (batch request),
 *    {{text}} renders as a JSON string (single request).
 *  - a response dot-path (e.g. "data.translations") pointing to either a
 *    string (single) or an array of strings / {translation|text|...} objects.
 */
import type { ProviderConfig } from '../shared/types';
import { escapeForJsonString, getByPath } from '../shared/utils';
import {
  ProviderError,
  classifyHttpStatus,
  readApiErrorMessage,
  registerProviderFactory,
  toProviderError,
  withTimeoutAndRetry,
} from './provider';
import type { TranslationContext, TranslationProvider } from './provider';

const OBJECT_TEXT_KEYS = ['translation', 'translatedText', 'text', 'target', 'result'];

export class CustomHttpProvider implements TranslationProvider {
  constructor(public readonly config: ProviderConfig) {}

  async translateTexts(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    const template = this.config.bodyTemplate ?? '';
    const supportsBatch = template.includes('{{texts}}');
    if (supportsBatch || texts.length === 1) {
      const result = await this.request(texts, ctx, signal);
      return this.parseResult(result, texts.length);
    }
    // No batch placeholder: loop single-item requests.
    const out: string[] = [];
    for (const text of texts) {
      const result = await this.request([text], ctx, signal);
      out.push(...this.parseResult(result, 1));
    }
    return out;
  }

  private buildUrl(): string {
    let url = this.config.baseUrl.trim();
    if (url === '') throw new ProviderError('config', '未配置 Base URL');
    if (this.config.apiKeyPlacement === 'query' && this.config.apiKey !== '') {
      const name = this.config.apiKeyParamName || 'api_key';
      url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(name)}=${encodeURIComponent(this.config.apiKey)}`;
    }
    return url;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };
    if (this.config.apiKeyPlacement !== 'query' && this.config.apiKeyPlacement !== 'body' && this.config.apiKey !== '') {
      const name = this.config.apiKeyParamName || 'Authorization';
      const value =
        name.toLowerCase() === 'authorization' && !/\s/.test(this.config.apiKey)
          ? `Bearer ${this.config.apiKey}`
          : this.config.apiKey;
      headers[name] = value;
    }
    return headers;
  }

  private renderBody(texts: string[], ctx: TranslationContext): string | undefined {
    const template = this.config.bodyTemplate;
    if (!template || template.trim() === '') return undefined;
    let rendered = template
      .replace(/\{\{\s*texts\s*\}\}/g, JSON.stringify(texts))
      .replace(/\{\{\s*text\s*\}\}/g, JSON.stringify(texts[0] ?? ''));
    const simpleVars: Record<string, string> = {
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      model: this.config.model,
      domain: ctx.domain ?? '',
      glossary: ctx.glossary ?? '',
      apiKey: this.config.apiKey,
    };
    rendered = rendered.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(simpleVars, name)
        ? escapeForJsonString(simpleVars[name])
        : match,
    );
    // Validate it is proper JSON; also add api key in body when requested.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rendered);
    } catch {
      throw new ProviderError('config', 'Body 模板替换变量后不是合法 JSON，请检查模板');
    }
    if (
      this.config.apiKeyPlacement === 'body' &&
      this.config.apiKey !== '' &&
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const name = this.config.apiKeyParamName || 'api_key';
      (parsed as Record<string, unknown>)[name] = this.config.apiKey;
    }
    return JSON.stringify(parsed);
  }

  private async request(texts: string[], ctx: TranslationContext, signal: AbortSignal): Promise<unknown> {
    const url = this.buildUrl();
    const method = this.config.method ?? 'POST';
    const headers = this.buildHeaders();
    const body = method === 'GET' ? undefined : this.renderBody(texts, ctx);

    return withTimeoutAndRetry(
      async (innerSignal) => {
        let res: Response;
        try {
          res = await fetch(url, { method, headers, body, signal: innerSignal });
        } catch (e) {
          throw toProviderError(e);
        }
        if (!res.ok) {
          const kind = classifyHttpStatus(res.status);
          const detail = await readApiErrorMessage(res);
          throw new ProviderError(
            kind,
            `API 请求失败 (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
          );
        }
        try {
          return await res.json();
        } catch {
          throw new ProviderError('invalid_response', 'API 返回了非 JSON 内容');
        }
      },
      { timeoutMs: this.config.timeoutMs, signal },
    );
  }

  private parseResult(json: unknown, expectedCount: number): string[] {
    const value = getByPath(json, this.config.responsePath);
    const texts = this.extractStrings(value);
    if (texts === null) {
      throw new ProviderError(
        'invalid_response',
        `无法从响应路径 "${this.config.responsePath || '(root)'}" 解析出译文`,
      );
    }
    if (texts.length === expectedCount) return texts;
    if (expectedCount === 1 && texts.length > 0) return [texts.join('\n')];
    throw new ProviderError(
      'invalid_response',
      `响应译文数量不匹配（期望 ${expectedCount} 条，实际 ${texts.length} 条）`,
    );
  }

  private extractStrings(value: unknown): string[] | null {
    if (typeof value === 'string') return value.trim() === '' ? null : [value];
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        out.push(item);
      } else if (item !== null && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const found = OBJECT_TEXT_KEYS.find((k) => typeof record[k] === 'string');
        if (!found) return null;
        out.push(record[found] as string);
      } else {
        return null;
      }
    }
    return out;
  }
}

registerProviderFactory('custom-http', (config) => new CustomHttpProvider(config));
