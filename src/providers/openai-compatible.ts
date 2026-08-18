/**
 * OpenAI-compatible chat-completions provider (spec §8.2).
 * Works with OpenAI, DeepSeek, Moonshot, OpenRouter, Ollama (/v1), etc.
 *
 * 2.0 additions (spec 2.0 §7.3):
 *  - SSE streaming via translateStream() (stream: true);
 *  - system prompt templates are rendered with {{sourceLanguage}},
 *    {{targetLanguage}}, {{domain}}, {{glossary}} before sending.
 */
import type { ProviderConfig } from '../shared/types';
import { parseBatchTranslation, renderTemplate } from '../shared/utils';
import { buildVisionRequest, buildVisionUserPrompt } from '../ocr/llm-vision';
import {
  ProviderError,
  classifyHttpStatus,
  readApiErrorMessage,
  registerProviderFactory,
  toProviderError,
  withTimeoutAndRetry,
} from './provider';
import type { StreamDeltaHandler, TranslationContext, TranslationProvider } from './provider';

/** Batches at most this size retry item-by-item on unparseable output. */
const FANOUT_LIMIT = 6;

const LOCAL_ORIGIN_403_HINT =
  'Ollama 拒绝了扩展来源。请设置环境变量 OLLAMA_ORIGINS=*（或 chrome-extension://*）后从托盘退出并重启 Ollama';

function throwHttpFailure(
  status: number,
  detail: string,
  local: boolean,
  label: string,
): never {
  const kind = local && status === 403 ? 'config' : classifyHttpStatus(status);
  const suffix =
    local && status === 403 ? `：${LOCAL_ORIGIN_403_HINT}` : detail ? `: ${detail}` : '';
  throw new ProviderError(kind, `${label} (HTTP ${status})${suffix}`);
}

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

  /** SSE streaming for a single text (spec 2.0 §7.3). */
  async translateStream(
    text: string,
    ctx: TranslationContext,
    onDelta: StreamDeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    const { config } = this;
    if (config.apiKey.trim() === '' && !this.isLocalEndpoint()) {
      throw new ProviderError('config', '未配置 API Key，请先在设置页填写');
    }
    const template =
      config.userPromptTemplate.trim() !== ''
        ? config.userPromptTemplate
        : 'Translate the following text from {{sourceLanguage}} to {{targetLanguage}}:\n\n{{text}}';
    const userContent = renderTemplate(template, this.templateVars(ctx, { text }));
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.apiKey.trim() !== '' ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    };
    const body = JSON.stringify({
      model: config.model,
      stream: true,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      // Ollama Qwen3-class models otherwise spend the token budget on reasoning.
      ...(this.isLocalEndpoint() ? { think: false } : {}),
      messages: [
        ...(config.systemPrompt.trim() !== ''
          ? [{ role: 'system', content: this.renderSystemPrompt(ctx) }]
          : []),
        { role: 'user', content: userContent },
      ],
    });

    let full = '';
    await withTimeoutAndRetry(
      async (innerSignal) => {
        full = '';
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers, body, signal: innerSignal });
        } catch (e) {
          throw toProviderError(e);
        }
        if (!res.ok) {
          throwHttpFailure(
            res.status,
            await readApiErrorMessage(res),
            this.isLocalEndpoint(),
            'API 请求失败',
          );
        }
        if (!res.body) {
          throw new ProviderError('invalid_response', 'API 未返回流式响应体');
        }
        full = await this.consumeSse(res.body, onDelta, innerSignal);
        if (full.trim() === '') {
          throw new ProviderError('invalid_response', '流式响应未包含任何内容');
        }
      },
      { timeoutMs: config.timeoutMs, signal },
    );
    return full.trim();
  }

  /** Parse an SSE body stream, pushing content deltas; returns full text. */
  private async consumeSse(
    body: ReadableStream<Uint8Array>,
    onDelta: StreamDeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
      for (;;) {
        if (signal.aborted) throw new ProviderError('aborted', '请求已取消');
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; process complete ones only.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = rawEvent
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');
          if (data === '[DONE]') return full;
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            continue; // ignore keep-alive / malformed chunks
          }
          const delta = (json as { choices?: { delta?: { content?: unknown } }[] })
            ?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta !== '') {
            full += delta;
            onDelta(delta);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    return full;
  }

  /**
   * Vision capability (spec 3.0 §6.2): one chat/completions round trip whose
   * user message carries the image data URL. Returns the raw content string;
   * structured parsing lives in the OCR engine layer (src/ocr/llm-vision.ts).
   */
  async translateImage(
    dataUrl: string,
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string> {
    const { config } = this;
    if (config.apiKey.trim() === '' && !this.isLocalEndpoint()) {
      throw new ProviderError('config', '未配置 API Key，请先在设置页填写');
    }
    const prompt = buildVisionUserPrompt(ctx);
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.apiKey.trim() !== '' ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    };
    const body = JSON.stringify(
      buildVisionRequest(config.model, config.temperature, config.maxTokens, prompt, dataUrl),
    );
    return withTimeoutAndRetry(
      async (innerSignal) => {
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers, body, signal: innerSignal });
        } catch (e) {
          throw toProviderError(e);
        }
        if (!res.ok) {
          throwHttpFailure(
            res.status,
            await readApiErrorMessage(res),
            this.isLocalEndpoint(),
            '视觉翻译请求失败',
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
          throw new ProviderError('invalid_response', '视觉 API 响应缺少 choices[0].message.content');
        }
        return content;
      },
      { timeoutMs: config.timeoutMs, signal, retries: 1 },
    );
  }

  /**
   * ASR capability (spec 4.0 §5.4): multipart POST to /audio/transcriptions.
   * Prefers verbose_json for timestamps; falls back to plain text.
   */
  async transcribe(
    input: { mime: string; bytes: Uint8Array },
    ctx: TranslationContext & { languageHint?: string },
    signal: AbortSignal,
  ): Promise<{ text: string; segments?: Array<{ start: number; end: number; text: string }> }> {
    const { config } = this;
    if (config.apiKey.trim() === '' && !this.isLocalEndpoint()) {
      throw new ProviderError('config', '未配置 API Key，请先在设置页填写');
    }
    const url = `${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
    const headers: Record<string, string> = {
      ...(config.apiKey.trim() !== '' ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    };
    const ext = input.mime.includes('mp4') ? 'mp4' : input.mime.includes('mpeg') ? 'mp3' : 'webm';
    const copy = new Uint8Array(input.bytes.byteLength);
    copy.set(input.bytes);
    const file = new File([copy], `audio.${ext}`, { type: input.mime || 'audio/webm' });
    return withTimeoutAndRetry(
      async (innerSignal) => {
        const body = new FormData();
        body.append('file', file);
        body.append('model', config.model || 'whisper-1');
        body.append('response_format', 'verbose_json');
        if (ctx.languageHint && ctx.languageHint !== 'auto') {
          body.append('language', ctx.languageHint);
        }
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers, body, signal: innerSignal });
        } catch (e) {
          throw toProviderError(e);
        }
        if (!res.ok) {
          throwHttpFailure(
            res.status,
            await readApiErrorMessage(res),
            this.isLocalEndpoint(),
            '转写请求失败',
          );
        }
        const raw = await res.text();
        return parseTranscriptionResponse(raw);
      },
      { timeoutMs: config.timeoutMs, signal, retries: 1 },
    );
  }

  private isLocalEndpoint(): boolean {
    const url = this.config.baseUrl.toLowerCase();
    return url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0');
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

  /** Render the system prompt template (2.0: {{glossary}}/{{domain}} become real data). */
  private renderSystemPrompt(ctx: TranslationContext): string {
    return renderTemplate(this.config.systemPrompt, this.templateVars(ctx, { text: '', texts: '' }));
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
    const content = await this.chat(userContent, ctx, signal);
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

    const content = await this.chat(userContent, ctx, signal);
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
  private async chat(userContent: string, ctx: TranslationContext, signal: AbortSignal): Promise<string> {
    const { config } = this;
    if (config.apiKey.trim() === '' && !this.isLocalEndpoint()) {
      throw new ProviderError('config', '未配置 API Key，请先在设置页填写');
    }
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.apiKey.trim() !== '' ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    };
    const body = JSON.stringify({
      model: config.model,
      stream: false,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      // Ollama Qwen3-class models otherwise spend the token budget on reasoning.
      ...(this.isLocalEndpoint() ? { think: false } : {}),
      messages: [
        ...(config.systemPrompt.trim() !== ''
          ? [{ role: 'system', content: this.renderSystemPrompt(ctx) }]
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
          throwHttpFailure(
            res.status,
            await readApiErrorMessage(res),
            this.isLocalEndpoint(),
            'API 请求失败',
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

export function parseTranscriptionResponse(raw: string): {
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
} {
  const trimmed = raw.trim();
  if (trimmed === '') throw new ProviderError('invalid_response', '转写接口返回了空内容');
  try {
    const json: unknown = JSON.parse(trimmed);
    if (json && typeof json === 'object') {
      const rec = json as { text?: unknown; segments?: unknown };
      const text = typeof rec.text === 'string' ? rec.text : '';
      const segments = Array.isArray(rec.segments)
        ? rec.segments
            .map((s) => {
              if (!s || typeof s !== 'object') return null;
              const row = s as { start?: unknown; end?: unknown; text?: unknown };
              if (typeof row.text !== 'string' || row.text.trim() === '') return null;
              return {
                start: typeof row.start === 'number' ? row.start : 0,
                end: typeof row.end === 'number' ? row.end : 0,
                text: row.text,
              };
            })
            .filter((s): s is { start: number; end: number; text: string } => s !== null)
        : undefined;
      if (text !== '' || (segments && segments.length > 0)) {
        return { text: text || segments!.map((s) => s.text).join(' '), ...(segments ? { segments } : {}) };
      }
    }
  } catch {
    // plain-text fallback
  }
  return { text: trimmed };
}

registerProviderFactory('openai-compatible', (config) => new OpenAICompatibleProvider(config));