/**
 * Headless Edge + dist/ + local Ollama qwen3-14b-64k live translation check.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const PORT = 9334;
const PAGE = 8134;
const MODEL = process.env.OLLAMA_MODEL || 'qwen3-14b-64k';
const EDGE =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchJson(url) { return (await fetch(url)).json(); }

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });
    const client = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && client.pending.has(msg.id)) {
        const { resolve, reject } = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    return client;
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, timeoutMs);
    });
  }
  async eval(expression, timeoutMs = 20000) {
    const { result, exceptionDetails } = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(exceptionDetails));
    return result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const pageHtml = '<!doctype html><html><body><p id="live">The translation memory should reuse this exact sentence.</p></body></html>';
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((r) => server.listen(PAGE, r));

const profile = mkdtempSync(path.join(tmpdir(), 'polypage-ollama-live-'));
const child = spawn(EDGE, [
  '--user-data-dir=' + profile,
  '--load-extension=' + dist,
  '--disable-extensions-except=' + dist,
  '--enable-unsafe-extension-debugging',
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

function kill() {
  try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  try { server.close(); } catch { /* */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
}

try {
  const deadline = Date.now() + 40000;
  let sw;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson('http://127.0.0.1:' + PORT + '/json');
      sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
      if (sw) break;
    } catch { /* wait */ }
    await sleep(400);
  }
  if (!sw) throw new Error('extension SW not found');
  const extensionId = sw.url.match(/chrome-extension:\/\/([a-z]+)\//)[1];
  const version = await fetchJson('http://127.0.0.1:' + PORT + '/json/version');
  const browser = await CDP.connect(version.webSocketDebuggerUrl);
  const optionsUrl = 'chrome-extension://' + extensionId + '/options/options.html';
  await browser.send('Target.createTarget', { url: optionsUrl });
  let optionsTarget;
  for (let i = 0; i < 50; i++) {
    const targets = await fetchJson('http://127.0.0.1:' + PORT + '/json');
    optionsTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(optionsUrl));
    if (optionsTarget) break;
    await sleep(200);
  }
  const ext = await CDP.connect(optionsTarget.webSocketDebuggerUrl);
  await ext.send('Runtime.enable');
  await ext.eval(`(async () => {
    for (let i = 0; i < 50; i++) {
      const data = await chrome.storage.local.get('settings');
      if (data.settings) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('defaults never written');
  })()`);
  const settings = {
    schemaVersion: 5,
    activeProviderId: 'ollama-local',
    providers: [{
      id: 'ollama-local',
      name: 'Ollama live',
      type: 'openai-compatible',
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: MODEL,
      sourceLanguage: 'English',
      targetLanguage: '简体中文',
      timeoutMs: 180000,
      maxTokens: 256,
      temperature: 0.2,
      systemPrompt: 'You are a translation engine. Output ONLY the Simplified Chinese translation. No thinking, no explanation.',
      userPromptTemplate: 'Translate from {{sourceLanguage}} to {{targetLanguage}}:\\n\\n{{text}}',
      headers: {},
    }],
    defaultDisplayMode: 'bilingual',
    cacheEnabled: false,
    translationMemory: { enabled: false, maxEntries: 5000 },
    minTextLength: 6,
  };
  const saved = await ext.eval('chrome.runtime.sendMessage({ type: \"save-settings\", settings: ' + JSON.stringify(settings) + ' })');
  if (!saved?.ok) throw new Error('save-settings failed ' + JSON.stringify(saved));
  const pageUrl = 'http://127.0.0.1:' + PAGE + '/';
  await browser.send('Target.createTarget', { url: pageUrl });
  let pageTarget;
  for (let i = 0; i < 50; i++) {
    const targets = await fetchJson('http://127.0.0.1:' + PORT + '/json');
    pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(pageUrl));
    if (pageTarget) break;
    await sleep(200);
  }
  const page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await ext.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(pageUrl)}));
    if (!tab) throw new Error('no page tab');
    return await chrome.tabs.sendMessage(tab.id, { type: 'wt:translate' });
  })()`, 10000);
  let text = '';
  for (let i = 0; i < 90; i++) {
    text = await page.eval("document.body.innerText");
    const pending = text.includes('翻译中');
    const hasCjk = /[\u4e00-\u9fff]/.test(text);
    if (text && hasCjk && !pending && !text.includes('失败')) break;
    await sleep(2000);
  }
  console.log('LIVE_TEXT=' + JSON.stringify(text).slice(0, 800));
  if (!text || text.includes('翻译服务未配置') || text.includes('失败')) {
    throw new Error('live translation failed: ' + text);
  }
  if (text.includes('翻译中')) {
    throw new Error('still pending: ' + text);
  }
  if (!/[\u4e00-\u9fff]/.test(text)) {
    throw new Error('no CJK in live translation: ' + text);
  }
  console.log('OLLAMA LIVE CHECK PASSED');
  ext.close();
  page.close();
  browser.close();
  process.exitCode = 0;
} catch (e) {
  console.error('OLLAMA LIVE CHECK FAILED', e);
  process.exitCode = 1;
} finally {
  kill();
}
