/** Optional live benchmark. Run explicitly on the host with OpenCodeGo set.
 * Only the HTTP status, model, timings, usage and returned translations are printed. */
import { createServer } from 'vite';

const key = process.env.OpenCodeGo?.trim();
if (!key) throw new Error('请先在当前进程设置 OpenCodeGo');
const server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const load = name => server.ssrLoadModule('/src/' + name + '.ts');
const originalFetch = globalThis.fetch;
try {
  await load('providers/opencode-go');
  const { createProvider } = await load('providers/provider');
  const { listProviderModels } = await load('providers/modelCatalog');
  const { defaultProvider, defaultSettings } = await load('shared/constants');
  const { renderGlossary } = await load('shared/siteRules');
  const { buildContext } = await load('translation/context');
  const config = {
    ...defaultProvider(), type: 'opencode-go', apiKey: key, model: 'deepseek-v4.1-flash',
    sourceLanguage: 'English', targetLanguage: '简体中文', temperature: 0, thinkingLevel: 'low',
  };
  const catalog = await listProviderModels(config);
  if (!catalog.some(model => model.id === config.model)) throw new Error('基准模型不在当前文本模型目录中');
  const provider = createProvider(config);
  const glossary = [
    ['container', '集装箱'], ['pipeline', '流水线'], ['memory', '内存'], ['heap', '堆'],
    ['kernel', '内核'], ['frame', '帧'], ['gateway', '网关'], ['replica', '副本'], ['Atlas', '星图引擎'],
  ].map(([source, target]) => ({ source, target }));
  const cases = [
    ['网络', 'Operations manual', 'TCP sockets and inbound connections', ['The port is closed.']],
    ['港务', 'Operations manual', 'Harbors and cargo ships', ['The port is closed.']],
    ['跨段', 'Product guide', 'Atlas deployments', ['Start Atlas before deploying.', 'Atlas handles the new deployment.']],
    ['改名', 'Product guide', 'Atlas deployments', ['Start Atlas before deploying.']],
  ];
  let calls = [];
  globalThis.fetch = async (url, options) => {
    const time = performance.now();
    const response = await originalFetch(url, options);
    const result = await response.clone().json();
    const messages = JSON.parse(options.body).messages;
    calls.push({ http: response.status, model: result.model, chars: messages.reduce((n, m) => n + m.content.length, 0),
      inputTokens: result.usage?.prompt_tokens, ms: Math.round(performance.now() - time) });
    return response;
  };
  async function run(phase, name, texts, context) {
    calls = [];
    const translations = await provider.translateTexts(texts, context, AbortSignal.timeout(45_000));
    console.log(JSON.stringify({ phase, name, translations, calls }).replaceAll(key, '[redacted]'));
  }
  await run('探测', '最小翻译', ['Hello.'], buildContext(defaultSettings(), config));
  for (const phase of ['之前', '之后']) {
    for (const [name, title, section, texts] of cases) {
      const settings = defaultSettings();
      settings.glossary = glossary.map(g => name === '改名' && g.source === 'Atlas' ? { ...g, target: '星图系统' } : g);
      const current = buildContext(settings, config, undefined, null, { title, section }, texts);
      const prior = { sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage, glossary: renderGlossary(settings.glossary) };
      await run(phase, name, texts, phase === '之前' ? prior : current);
    }
  }
} catch (error) {
  console.error('对照未完成', error.kind ?? error.name);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
