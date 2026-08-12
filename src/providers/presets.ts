/**
 * Provider presets ("preset market", spec 2.0 §8.2).
 *
 * One-click templates that pre-fill endpoint/model/prompt recommendations;
 * after creating from a preset the user normally only has to paste an API
 * key. Presets never modify providers the user already created.
 */
import { DEFAULT_NATIVE_HOST_NAME, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } from '../shared/constants';
import type { ProviderConfig, ProviderType } from '../shared/types';
import { defaultProvider } from '../shared/constants';

export interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  needsApiKey: boolean;
  systemPrompt?: string;
  userPromptTemplate?: string;
  bodyTemplate?: string;
  responsePath?: string;
  apiKeyPlacement?: 'header' | 'query' | 'body';
  apiKeyParamName?: string;
  maxBatchItems?: number;
  maxBatchChars?: number;
  /** native-host only. */
  hostName?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'preset-openai',
    name: 'OpenAI',
    description: 'OpenAI 官方 API（gpt-4o-mini）',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsApiKey: true,
  },
  {
    id: 'preset-deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 官方 API（deepseek-chat）',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsApiKey: true,
  },
  {
    id: 'preset-moonshot',
    name: 'Moonshot (Kimi)',
    description: '月之暗面 Moonshot API（moonshot-v1-8k）',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needsApiKey: true,
  },
  {
    id: 'preset-openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter 聚合网关（多模型）',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    needsApiKey: true,
  },
  {
    id: 'preset-ollama',
    name: 'Ollama (本地)',
    description: '本地 Ollama 的 OpenAI 兼容接口，无需 API Key',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsApiKey: false,
  },
  {
    id: 'preset-deepl',
    name: 'DeepL',
    description: 'DeepL API Free/Pro（需 DeepL Auth Key）',
    type: 'deepl',
    baseUrl: 'https://api-free.deepl.com',
    model: '',
    needsApiKey: true,
  },
  {
    id: 'preset-azure-translator',
    name: 'Azure Translator',
    description: 'Azure AI 翻译服务（订阅密钥 + 区域）',
    type: 'azure-translator',
    baseUrl: 'https://api.cognitive.microsofttranslator.com',
    model: '',
    needsApiKey: true,
  },
  {
    id: 'preset-google-translate',
    name: 'Google Translate',
    description: 'Google Cloud Translation v2（API Key）',
    type: 'google-translate',
    baseUrl: 'https://translation.googleapis.com/language/translate/v2',
    model: '',
    needsApiKey: true,
  },
  {
    id: 'preset-native-host',
    name: '本地网关 (PolyPage Gateway)',
    description: '经由本地 .NET 网关调用 Ollama/企业内网服务',
    type: 'native-host',
    baseUrl: '',
    model: '',
    needsApiKey: false,
    hostName: DEFAULT_NATIVE_HOST_NAME,
  },
  {
    id: 'preset-corp-http',
    name: '企业 HTTP 网关（样例）',
    description: '内网 JSON 翻译服务示例（自行修改 Body 模板与响应路径）',
    type: 'custom-http',
    baseUrl: 'http://intranet.example.com/api/translate',
    model: '',
    needsApiKey: false,
    bodyTemplate: `{
  "texts": {{texts}},
  "from": "{{sourceLanguage}}",
  "to": "{{targetLanguage}}"
}`,
    responsePath: 'data.translations',
    apiKeyPlacement: 'header',
    apiKeyParamName: 'Authorization',
  },
];

/** Materialize a preset into a fresh ProviderConfig. */
export function presetToProvider(preset: ProviderPreset, id: string, name?: string): ProviderConfig {
  const base = defaultProvider();
  const provider: ProviderConfig = {
    ...base,
    id,
    name: name ?? preset.name,
    type: preset.type,
    baseUrl: preset.baseUrl,
    model: preset.model,
    maxBatchItems: preset.maxBatchItems ?? base.maxBatchItems,
    maxBatchChars: preset.maxBatchChars ?? base.maxBatchChars,
  };
  if (preset.type === 'openai-compatible') {
    provider.systemPrompt = preset.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    provider.userPromptTemplate = preset.userPromptTemplate ?? DEFAULT_USER_PROMPT;
  }
  if (preset.type === 'custom-http') {
    provider.method = 'POST';
    provider.bodyTemplate = preset.bodyTemplate ?? '';
    provider.responsePath = preset.responsePath ?? '';
    provider.apiKeyPlacement = preset.apiKeyPlacement ?? 'header';
    provider.apiKeyParamName = preset.apiKeyParamName ?? 'Authorization';
    provider.systemPrompt = '';
    provider.userPromptTemplate = '';
  }
  if (preset.type === 'native-host') {
    provider.hostName = preset.hostName ?? DEFAULT_NATIVE_HOST_NAME;
    provider.systemPrompt = '';
    provider.userPromptTemplate = '';
  }
  if (preset.type === 'deepl' || preset.type === 'azure-translator' || preset.type === 'google-translate') {
    provider.systemPrompt = '';
    provider.userPromptTemplate = '';
    provider.maxBatchItems = preset.maxBatchItems ?? 50;
    provider.maxBatchChars = preset.maxBatchChars ?? 20000;
  }
  return provider;
}

export function findPreset(presetId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === presetId);
}