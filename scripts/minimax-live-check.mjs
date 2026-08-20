/**
 * Headless Edge + dist/ + MiniMax Token Plan (env MiniMax) live text + vision check.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const PORT = 9335;
const PAGE = 8135;
const KEY = process.env.MiniMax || process.env.MINIMAX || '';
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const BASE = process.env.MINIMAX_BASE || 'https://api.minimax.chat/v1';
const EDGE =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pngPath = path.join(root, 'scripts', 'fixtures', 'hello-world.png');

if (!KEY) {
  console.error('MiniMax env var is empty. Set User environment variable MiniMax.');
  process.exit(2);
}

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

const png = readFileSync(pngPath);
const pageHtml = `<!doctype html><html><body>
<p id="live">Open source software changed the world.</p>
<img id="photo" src="/hello-world.png" alt="fixture" style="width:360px;height:80px" />
</body></html>`;
const server = createServer((req, res) => {
  if ((req.url || '').startsWith('/hello-world.png')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(png);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((r) => server.listen(PAGE, r));

const profile = mkdtempSync(path.join(tmpdir(), 'polypage-minimax-live-'));
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
    activeProviderId: 'minimax-live',
    providers: [{
      id: 'minimax-live',
      name: 'MiniMax live',
      type: 'openai-compatible',
      enabled: true,
      baseUrl: BASE,
      apiKey: KEY,
      model: MODEL,
      sourceLanguage: 'English',
      targetLanguage: '简体中文',
      timeoutMs: 180000,
      maxTokens: 512,
      temperature: 0.2,
      systemPrompt: 'You are a translation engine. Output ONLY the Simplified Chinese translation.',
      userPromptTemplate: 'Translate from {{sourceLanguage}} to {{targetLanguage}}:\\n\\n{{text}}',
      headers: {},
    }],
    defaultDisplayMode: 'bilingual',
    cacheEnabled: false,
    translationMemory: { enabled: false, maxEntries: 5000 },
    imageTranslate: { enabled: true, trigger: 'both', engine: 'llm-vision', maxEdgePx: 4096, tessLangs: ['eng', 'chi_sim'] },
    minTextLength: 6,
  };
  const saved = await ext.eval('chrome.runtime.sendMessage({ type: "save-settings", settings: ' + JSON.stringify(settings) + ' })');
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
  for (let i = 0; i < 60; i++) {
    text = await page.eval('document.body.innerText');
    const pending = text.includes('翻译中');
    const hasCjk = /[\u4e00-\u9fff]/.test(text);
    if (text && hasCjk && !pending && !text.includes('失败')) break;
    await sleep(1500);
  }
  console.log('LIVE_TEXT=' + JSON.stringify(text).slice(0, 400));
  if (!/[\u4e00-\u9fff]/.test(text) || text.includes('翻译中') || text.includes('失败')) {
    throw new Error('text translation failed');
  }

  const ocr = await ext.eval(`chrome.runtime.sendMessage({
    type: 'ocr-request',
    requestId: 'mm-live',
    url: ${JSON.stringify(pageUrl + 'hello-world.png')},
    naturalWidth: 360,
    naturalHeight: 80,
  })`, 120000);
  console.log('LIVE_OCR=' + JSON.stringify(ocr).slice(0, 600));
  const segs = ocr?.ok ? ocr.segments : [];
  const blob = JSON.stringify(segs);
  if (!ocr?.ok) throw new Error('ocr failed: ' + JSON.stringify(ocr));
  if (!/HELLO/i.test(blob) && !/你好/.test(blob)) {
    throw new Error('ocr missing expected text');
  }
  console.log('MINIMAX LIVE CHECK PASSED');
  ext.close();
  page.close();
  browser.close();
  process.exitCode = 0;
} catch (e) {
  console.error('MINIMAX LIVE CHECK FAILED', e);
  process.exitCode = 1;
} finally {
  kill();
}
