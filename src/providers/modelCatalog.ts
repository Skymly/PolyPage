import { OPENCODE_GO_URL } from '../shared/constants';
import { isReasoningEffort, type ReasoningEffort } from '../shared/modelThinking';
import { supportsProviderModelList, type ProviderConfig, type ProviderModel } from '../shared/types';
import { assertHttpBaseUrl, ProviderError, providerHttpError, withTimeoutAndRetry } from './provider';

interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  input_modalities?: unknown;
  output_modalities?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  capabilities?: { reasoning?: { supported?: unknown; toggle?: unknown; effort?: unknown } };
  effort?: { supported_levels?: unknown };
}

const NON_TEXT_TYPES = new Set(['audio', 'embedding', 'image', 'moderation', 'rerank', 'speech', 'video']);

function modelReasoningEfforts(item: CatalogEntry, host: string): ReasoningEffort[] | undefined {
  const reasoning = item.capabilities?.reasoning;
  if (reasoning?.supported === false) return [];
  if (reasoning?.supported === true) {
    const efforts = Array.isArray(reasoning.effort) ? reasoning.effort.filter(isReasoningEffort) : [];
    if (reasoning.toggle === true) efforts.unshift('none');
    return [...new Set(efforts)];
  }
  const levels = item.effort?.supported_levels;
  if (host === 'api.deepseek.com' && Array.isArray(levels)) {
    return [...new Set<ReasoningEffort>(['none', ...levels.filter(isReasoningEffort)])];
  }
  return undefined;
}

export async function listProviderModels(config: ProviderConfig): Promise<ProviderModel[]> {
  if (!supportsProviderModelList(config.type)) throw new ProviderError('config', '此服务没有模型列表接口');
  const headers = new Headers({ Accept: 'application/json' });
  let url: URL;
  if (config.type === 'opencode-go') {
    url = new URL(`${OPENCODE_GO_URL}/v1/models`);
  } else {
    url = assertHttpBaseUrl(config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
    url.hash = '';
    try {
      for (const [name, value] of Object.entries(config.headers)) headers.set(name, value);
      const key = config.apiKey.trim();
      if (key && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${key}`);
    } catch {
      throw new ProviderError('config', '请检查 API Key 和自定义请求头格式');
    }
  }

  return withTimeoutAndRetry(async (signal) => {
    const response = await fetch(url.toString(), {
      headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw providerHttpError(response, '当前地址没有模型列表接口');
    }
    if (response.status === 401 || response.status === 403) {
      throw providerHttpError(response, '认证失败，请检查 API Key 和模型访问权限');
    }
    if (!response.ok) throw providerHttpError(response, '获取模型列表失败');
    let json: { data?: unknown } | null;
    try {
      json = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderError('invalid_response', '模型列表接口未返回 JSON');
    }
    if (!Array.isArray(json?.data)) throw new ProviderError('invalid_response', '模型列表格式无效');

    const models = new Map<string, ProviderModel>();
    for (const item of json.data as Array<CatalogEntry | null>) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!item || !id || models.has(id)) continue;
      if (typeof item.type === 'string' && NON_TEXT_TYPES.has(item.type)) continue;
      const input = item.modalities?.input ?? item.input_modalities ?? item.architecture?.input_modalities;
      const output = item.modalities?.output ?? item.output_modalities ?? item.architecture?.output_modalities;
      if (Array.isArray(input) && !input.includes('text')) continue;
      if (Array.isArray(output) && !output.includes('text')) continue;
      const name = [item.name, item.display_name].find((value) => typeof value === 'string' && value.trim());
      const reasoningEfforts = modelReasoningEfforts(item, url.hostname);
      models.set(id, {
        id,
        name: typeof name === 'string' ? name.trim() : id,
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
      });
    }
    if (models.size === 0) throw new ProviderError('invalid_response', '服务未返回可用的文本模型');
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, { timeoutMs: Math.min(config.timeoutMs, 12_000), retries: 0 });
}
