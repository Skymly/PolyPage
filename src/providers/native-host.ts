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

registerProviderFactory('native-host', (config) => new NativeHostProvider(config));