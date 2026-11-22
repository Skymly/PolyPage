import { DEFAULT_BASE_URLS, OPENCODE_GO_URL } from '../shared/constants';
import { OpenAICompatibleProvider } from './openai-compatible';
import {
  ProviderError,
  providerHttpError,
  registerProviderFactory,
  withTimeoutAndRetry,
} from './provider';

registerProviderFactory('opencode-go', (config) => {
  const model = config.model.trim().replace(/^opencode-go\//, '');
  if (!model) throw new ProviderError('config', '请选择或填写 OpenCode Go 模型');
  // Go translates between model protocols at the current inference endpoint.
  // Keep the same session for retries and batch fallback inside this instance.
  const chat = new OpenAICompatibleProvider({
    ...config,
    baseUrl: DEFAULT_BASE_URLS['opencode-go'],
    apiKey: config.apiKey.trim(),
    model,
    headers: { 'x-opencode-session': `ses_${crypto.randomUUID()}` },
  });
  return {
    config,
    translateTexts: chat.translateTexts.bind(chat),
    translateStream: config.supportsStreaming === false ? undefined : chat.translateStream.bind(chat),
  };
});

const QUOTA_WINDOWS = ['rolling', 'weekly', 'monthly'] as const;
export type OpenCodeGoQuotaWindow = typeof QUOTA_WINDOWS[number];
export type OpenCodeGoQuota = Record<OpenCodeGoQuotaWindow, { percent: number; resetsAt: string | null }>;

export interface OpenCodeGoQuotaStatus {
  checkedAt: number;
  lastSuccess?: { fetchedAt: number; windows: OpenCodeGoQuota };
  error?: string;
}

async function fetchQuotaJson(apiKey: string): Promise<unknown> {
  return withTimeoutAndRetry(async (signal) => {
    const res = await fetch(`${OPENCODE_GO_URL}/v1/usage`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    if (res.status === 401) {
      throw new ProviderError('auth', 'OpenCode Go API Key 无效（HTTP 401）');
    }
    if (res.status === 403) {
      throw new ProviderError('auth', '此 API Key 无权查看额度，请确认它属于已订阅 OpenCode Go 的工作区（HTTP 403）');
    }
    if (!res.ok) throw providerHttpError(res, '无法查询 OpenCode Go 额度');
    try {
      return await res.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderError('invalid_response', 'OpenCode Go 额度接口未返回 JSON');
    }
  }, { timeoutMs: 10_000, retries: 0 });
}

export async function fetchOpenCodeGoQuota(apiKey: string): Promise<OpenCodeGoQuota> {
  if (!apiKey.trim()) throw new ProviderError('config', '请先填写 OpenCode Go API Key');
  const json = await fetchQuotaJson(apiKey.trim()) as {
    usage?: Partial<Record<OpenCodeGoQuotaWindow, { percent?: unknown; resetsAt?: unknown }>>;
  } | null;
  const readWindow = (window: OpenCodeGoQuotaWindow) => {
    const data = json?.usage?.[window];
    const percent = data?.percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) {
      throw new ProviderError('invalid_response', 'OpenCode Go 额度数据不完整或格式无效');
    }
    const resetsAt = data?.resetsAt;
    return {
      percent,
      resetsAt: typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt)) ? resetsAt : null,
    };
  };
  const [rolling, weekly, monthly] = QUOTA_WINDOWS.map(readWindow);
  return { rolling, weekly, monthly };
}
