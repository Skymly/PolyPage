/**
 * OpenAI-compatible chat-completions provider (spec §8.2).
 * Works with OpenAI, DeepSeek, Moonshot, OpenRouter, Ollama (OpenAI mode),
 * Azure OpenAI compatible endpoints, etc.
 */
import type { ProviderConfig } from '../shared/types';
import { parseBatchTranslation, renderTemplate } from '../shared/utils';
import {
  ProviderError,
  classifyHttpStatus,
  readApiErrorMessage,
  registerProviderFactory,
  toProviderError,
  withTimeoutAndRetry,
} from './provider';
import type { TranslationContext, TranslationProvider } from './provider';

/** Batches larger than this fall back to an error instead of per-item fan-out. */
const FANOUT_LIMIT = 12;

export class OpenAICompatibleProvider implements TranslationProvider {
  constructor(public readonly config: ProviderConfig) {}

  async translateTexts(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) {
      return [await this.translateSingle(texts[0], ctx, signal)];
    }
    try {
      return await this.translateBatch(texts, ctx, signal);
    } catch (e) {
      const err = toProviderError(e);
      // Structured output mismatch: retry item-by-item for small batches.
      if (err.kind === 'invalid_response' && texts.length <= FANOUT_LIMIT) {
        return this.translateSequentially(texts, ctx, signal);
      }
      throw err;
    }
  }

  private async translateSequentially(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const text of texts) {
      out.push(await this.translateSingle(text, ctx, signal));
    }
    return out;
  }

  private templateVars(ctx: TranslationContext, extra: Record<string, string>) {
    return {
      sourceLanguage: ctx.sourceLanguage,
      targetLanguage: ctx.targetLanguage,
      domain: ctx.domain ?? '',
      glossary: ctx.glossary ?? '',
      ...extra,
    };
  }

  private async translateSingle(
    text: string,
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string> {
    const template =
      this.config.userPromptTemplate.trim() !== ''
        ? this.config.userPromptTemplate
        : 'Translate the following text from {{sourceLanguage}} to {{targetLanguage}}:\n\n{{text}}';
    const userContent = renderTemplate(template, this.templateVars(ctx, { text }));
    const content = await this.chat(userContent, signal);
    const trimmed = content.trim();
    if (trimmed === '') {
      throw new ProviderError('invalid_response', '模型返回了空内容');
    }
    return trimmed;
  }

  private async translateBatch(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    const numbered = texts.map((t, i) => `${i + 1}) ${t}`).join('\n');
    const userContent = this.config.userPromptTemplate.includes('{{texts}}')
      ? renderTemplate(this.config.userPromptTemplate, this.templateVars(ctx, { texts: numbered }))
      : `Translate the following ${texts.length} texts from {{sourceLanguage}} to {{targetLanguage}}.
Return ONLY a JSON array of exactly ${texts.length} translated strings, in the same order. Do not output anything else.

${numbered}`.replace('{{sourceLanguage}}', ctx.sourceLanguage).replace('{{targetLanguage}}', ctx.targetLanguage);

    const content = await this.chat(userContent, signal);
    const parsed = parseBatchTranslation(content, texts.length);
    if (!parsed) {
      throw new ProviderError(
        'invalid_response',
        `批量翻译结果无法解析（期望 ${texts.length} 条）`,
      );
    }
    return parsed;
  }

  /** One chat-completions round trip, returns the assistant message content. */
  private async chat(userContent: string, signal: AbortSignal): Promise<string> {
    const { config } = this;
    if (config.apiKey.trim() === '') {
      throw new ProviderError('config', '未配置 API Key，请先在设置页填写');
    }
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...config.headers,
    };
    const body = JSON.stringify({
      model: config.model,
      stream: false,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages: [
        ...(config.systemPrompt.trim() !== ''
          ? [{ role: 'system', content: config.systemPrompt }]
          : []),
        { role: 'user', content: userContent },
      ],
    });

    return withTimeoutAndRetry(
      async (innerSignal) => {
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers, body, signal: innerSignal });
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
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new ProviderError('invalid_response', 'API 返回了非 JSON 内容');
        }
        const content = (json as { choices?: { message?: { content?: unknown } }[] })
          ?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new ProviderError('invalid_response', 'API 响应缺少 choices[0].message.content');
        }
        return content;
      },
      { timeoutMs: config.timeoutMs, signal },
    );
  }
}

registerProviderFactory('openai-compatible', (config) => new OpenAICompatibleProvider(config));
