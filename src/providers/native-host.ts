/**
 * native-host provider (spec 2.0 pillar A / §5.3).
 *
 * Registered through registerProviderFactory() like every other provider.
 * Talks JSON-RPC 2.0 over Native Messaging to the local PolyPage Gateway;
 * the gateway holds all backend credentials — the browser side never sees
 * them (spec 2.0 §5.1).
 *
 * When the gateway is not installed the provider throws ProviderError with
 * kind "config", which the background's failover logic treats as a trigger
 * to try the fallback provider (spec 2.0 §5.6).
 */
import type { ProviderConfig } from '../shared/types';
import { DEFAULT_NATIVE_HOST_NAME } from '../shared/constants';
import type { GatewayCapabilities } from '../shared/nativeRpc';
import { nativeNotify, nativeRequest } from '../background/nativePort';
import { base64ToBytes, sha256Hex, splitBinaryChunks } from '../shared/binaryChunk';
import {
  ProviderError,
  registerProviderFactory,
} from './provider';
import type { StreamDeltaHandler, TranslationContext, TranslationProvider } from './provider';

interface GatewayTranslateResult {
  translations?: unknown;
  backend?: string;
}

export class NativeHostProvider implements TranslationProvider {
  constructor(public readonly config: ProviderConfig) {}

  private get hostName(): string {
    return this.config.hostName?.trim() || DEFAULT_NATIVE_HOST_NAME;
  }

  private baseParams(ctx: TranslationContext): Record<string, unknown> {
    const params: Record<string, unknown> = {
      source: ctx.sourceLanguage,
      target: ctx.targetLanguage,
    };
    const backend = this.config.backend?.trim();
    if (backend) params.backend = backend;
    return params;
  }

  async translateTexts(
    texts: string[],
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    let requestId = 0;
    const onAbort = () => {
      if (requestId > 0) nativeNotify(this.hostName, 'cancel', { id: requestId });
    };
    signal.addEventListener('abort', onAbort);
    try {
      const result = await nativeRequest<GatewayTranslateResult>(
        this.hostName,
        'translate',
        { texts, stream: false, ...this.baseParams(ctx) },
        {
          timeoutMs: this.config.timeoutMs,
          onId: (id) => {
            requestId = id;
            if (signal.aborted) onAbort();
          },
        },
      );
      return this.parseTranslations(result, texts.length);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Streaming single-text translation through gateway notifications. */
  async translateStream(
    text: string,
    ctx: TranslationContext,
    onDelta: StreamDeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    let requestId = 0;
    const onAbort = () => {
      if (requestId > 0) nativeNotify(this.hostName, 'cancel', { id: requestId });
    };
    signal.addEventListener('abort', onAbort);
    try {
      const result = await nativeRequest<{ translation?: unknown }>(
        this.hostName,
        'translate.stream',
        { text, ...this.baseParams(ctx) },
        {
          timeoutMs: this.config.timeoutMs,
          onId: (id) => {
            requestId = id;
            if (signal.aborted) onAbort();
          },
          onNotification: (method, params) => {
            if (method !== 'translate.delta') return;
            const delta = (params as { delta?: unknown })?.delta;
            if (typeof delta === 'string' && delta !== '') onDelta(delta);
          },
        },
      );
      const translation = result?.translation;
      if (typeof translation !== 'string' || translation.trim() === '') {
        throw new ProviderError('invalid_response', '本地网关流式响应缺少最终译文');
      }
      return translation;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Query gateway capabilities (used by host-status UI). */
  async capabilities(): Promise<GatewayCapabilities> {
    return nativeRequest<GatewayCapabilities>(this.hostName, 'capabilities', {}, { timeoutMs: 8000 });
  }

  async translateImage(
    dataUrl: string,
    ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<string> {
    const caps = await this.capabilities();
    if ((caps.protocol ?? 1) < 2 || !caps.supportsVision) {
      throw new ProviderError('config', '本地网关不支持视觉翻译（需要协议 v2 且 supportsVision）');
    }
    const inline = dataUrl.length < 600_000;
    const params: Record<string, unknown> = { ...this.baseParams(ctx) };
    if (inline) {
      params.dataUrl = dataUrl;
    } else {
      const bytes = dataUrlToBytes(dataUrl);
      params.transferId = await this.uploadBinary(bytes, mimeFromDataUrl(dataUrl), signal);
    }
    const result = await this.rpc<{ segments?: unknown }>(
      'translate.image',
      params,
      signal,
    );
    const segments = result?.segments;
    if (!Array.isArray(segments)) {
      throw new ProviderError('invalid_response', '本地网关视觉响应缺少 segments');
    }
    return JSON.stringify(segments);
  }

  async transcribe(
    input: { mime: string; bytes: Uint8Array },
    ctx: TranslationContext & { languageHint?: string },
    signal: AbortSignal,
  ): Promise<{ text: string; segments?: Array<{ start: number; end: number; text: string }> }> {
    const caps = await this.capabilities();
    if ((caps.protocol ?? 1) < 2 || !caps.supportsAsr) {
      throw new ProviderError('config', '本地网关不支持转写（需要协议 v2 且 supportsAsr）');
    }
    const transferId = await this.uploadBinary(input.bytes, input.mime, signal);
    const result = await this.rpc<{ text?: unknown; segments?: unknown }>(
      'transcribe',
      {
        transferId,
        languageHint: ctx.languageHint,
        ...this.baseParams(ctx),
      },
      signal,
    );
    const text = typeof result?.text === 'string' ? result.text : '';
    const segments = Array.isArray(result?.segments)
      ? result.segments
          .map((s) => {
            if (!s || typeof s !== 'object') return null;
            const row = s as { start?: unknown; end?: unknown; text?: unknown };
            if (typeof row.text !== 'string') return null;
            return {
              start: typeof row.start === 'number' ? row.start : 0,
              end: typeof row.end === 'number' ? row.end : 0,
              text: row.text,
            };
          })
          .filter((s): s is { start: number; end: number; text: string } => s !== null)
      : undefined;
    if (text === '' && (!segments || segments.length === 0)) {
      throw new ProviderError('invalid_response', '本地网关转写响应为空');
    }
    return { text, ...(segments ? { segments } : {}) };
  }

  private async uploadBinary(bytes: Uint8Array, mime: string, signal: AbortSignal): Promise<string> {
    const transferId = `xfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const digest = await sha256Hex(bytes);
    const chunks = splitBinaryChunks(bytes, mime, transferId, digest);
    for (const chunk of chunks) {
      if (signal.aborted) throw new ProviderError('aborted', '请求已取消');
      await nativeRequest(this.hostName, 'binary.chunk', chunk, { timeoutMs: this.config.timeoutMs });
    }
    return transferId;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    let requestId = 0;
    const onAbort = () => {
      if (requestId > 0) nativeNotify(this.hostName, 'cancel', { id: requestId });
    };
    signal.addEventListener('abort', onAbort);
    try {
      return await nativeRequest<T>(this.hostName, method, params, {
        timeoutMs: this.config.timeoutMs,
        onId: (id) => {
          requestId = id;
          if (signal.aborted) onAbort();
        },
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private parseTranslations(result: GatewayTranslateResult | undefined, expected: number): string[] {
    const list = result?.translations;
    if (!Array.isArray(list)) {
      throw new ProviderError('invalid_response', '本地网关响应缺少 translations 数组');
    }
    const out = list.map((t) => (typeof t === 'string' ? t : ''));
    if (out.length !== expected || out.some((t) => t === '')) {
      throw new ProviderError(
        'invalid_response',
        `本地网关译文数量不匹配（期望 ${expected} 条，实际 ${out.length} 条）`,
      );
    }
    return out;
  }
}

function mimeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match?.[1] || 'image/png';
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return base64ToBytes(payload);
}

registerProviderFactory('native-host', (config) => new NativeHostProvider(config));