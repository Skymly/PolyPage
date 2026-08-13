/**
 * Provider abstraction (spec §8). Concrete API logic lives only in provider
 * implementations — never in UI or content scripts.
 *
 * New provider types (DeepL, Ollama, native-host, enterprise gateway...) plug
 * in via registerProviderFactory() without touching the rest of the code.
 *
 * 2.0: providers may implement the optional streaming interface
 * translateStream() (spec 2.0 §7.3); non-streaming providers fall back to a
 * single-shot translateTexts() result.
 */
import { MAX_RETRIES } from '../shared/constants';
import type { ErrorKind, ProviderConfig, ProviderType } from '../shared/types';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return (
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'rate_limit' ||
      this.kind === 'server'
    );
  }
}

export interface TranslationContext {
  sourceLanguage: string;
  targetLanguage: string;
  /** Current page domain, available as {{domain}} in prompt templates. */
  domain?: string;
  /** Optional glossary text, available as {{glossary}} in prompt templates. */
  glossary?: string;
}

/** Incremental streaming callback. */
export type StreamDeltaHandler = (delta: string) => void;

export interface TranslationProvider {
  readonly config: ProviderConfig;
  /**
   * Translate a batch of texts and return translations in the same order.
   * Throws ProviderError on failure.
   */
  translateTexts(texts: string[], ctx: TranslationContext, signal: AbortSignal): Promise<string[]>;
  /**
   * Optional streaming translation of a single text (spec 2.0 §7.3).
   * Implementations push deltas through onDelta and resolve with the full
   * text. Absence means the provider does not support streaming.
   */
  translateStream?(
    text: string,
    ctx: TranslationContext,
    onDelta: StreamDeltaHandler,
    signal: AbortSignal,
  ): Promise<string>;
  /**
   * Optional vision translation of one image (spec 3.0 §6.2, pillar F).
   * Implementations send the data URL plus a structured prompt to a
   * multimodal model and return the raw assistant content. Absence means
   * the provider does not support vision (entries grey out, spec §6.2.3).
   */
  translateImage?(dataUrl: string, ctx: TranslationContext, signal: AbortSignal): Promise<string>;
}

/** True when the provider instance supports streaming. */
export function providerSupportsStreaming(provider: TranslationProvider): boolean {
  return typeof provider.translateStream === 'function';
}

/** True when the provider instance implements the vision capability (3.0). */
export function providerSupportsVision(provider: TranslationProvider): boolean {
  return typeof provider.translateImage === 'function';
}

/* ------------------------------ factory registry ----------------------------- */

type ProviderFactory = (config: ProviderConfig) => TranslationProvider;

const factories = new Map<ProviderType, ProviderFactory>();

/** Extension point for future provider types (e.g. a native-host provider). */
export function registerProviderFactory(type: ProviderType, factory: ProviderFactory): void {
  factories.set(type, factory);
}

export function createProvider(config: ProviderConfig): TranslationProvider {
  const factory = factories.get(config.type);
  if (!factory) {
    throw new ProviderError('config', `不支持的 Provider 类型: ${config.type}`);
  }
  return factory(config);
}

/* ------------------------------ shared http helpers -------------------------- */

export function classifyHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'config'; // 4xx (bad request, bad model name, context too long...)
}

export const RETRYABLE_HTTP: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'rate_limit',
  'server',
]);

/**
 * Run an async operation with timeout, external cancellation and basic retry
 * (spec §8: timeout control, cancellation, basic retry).
 */
export async function withTimeoutAndRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal; retries?: number; label?: string },
): Promise<T> {
  const retries = options.retries ?? MAX_RETRIES;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) {
      throw new ProviderError('aborted', '请求已取消');
    }
    try {
      return await runOnce(operation, options.timeoutMs, options.signal);
    } catch (e) {
      lastError = e;
      const err = toProviderError(e);
      const isTimeoutOrNetwork = err.kind === 'timeout' || err.kind === 'network';
      const canRetry =
        attempt < retries && (err.retryable || isTimeoutOrNetwork) && err.kind !== 'aborted';
      if (!canRetry) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
  throw toProviderError(lastError);
}

async function runOnce<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort);
  try {
    return await operation(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) {
      if (external?.aborted) throw new ProviderError('aborted', '请求已取消');
      if (timedOut) throw new ProviderError('timeout', `请求超时（${timeoutMs}ms）`);
      throw new ProviderError('aborted', '请求已取消');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/** Normalize any thrown value into a ProviderError. */
export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof TypeError) return new ProviderError('network', `网络错误: ${e.message}`);
  const message = e instanceof Error ? e.message : String(e);
  return new ProviderError('unknown', message);
}

/** Read a short error message from an API error response body (best effort). */
export async function readApiErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === 'object') {
        const record = json as Record<string, unknown>;
        const candidate =
          record.message ?? record.error ?? record.detail ?? record.description;
        if (typeof candidate === 'string') return candidate.slice(0, 300);
        if (
          candidate &&
          typeof candidate === 'object' &&
          typeof (candidate as Record<string, unknown>).message === 'string'
        ) {
          return ((candidate as Record<string, unknown>).message as string).slice(0, 300);
        }
      }
    } catch {
      // not JSON — fall through to raw text
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}