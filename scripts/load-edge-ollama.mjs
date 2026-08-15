/**
 * Launch headed Edge with dist/ loaded and write a local Ollama provider
 * (qwen3.8:27b) into the extension settings for manual testing.
 *
 * Usage: node scripts/load-edge-ollama.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const PORT = 9333;
const EDGE =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile =
  process.env.POLYPAGE_EDGE_PROFILE ||
  path.join(process.env.LOCALAPPDATA || '', 'PolyPage', 'edge-dev-profile');
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.8:27b';
const BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434/v1';

if (!existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('dist/ is missing; run node scripts/build.mjs first');
}
if (!existsSync(EDGE)) {
  throw new Error(`Edge not found at ${EDGE}`);
}

mkdirSync(profile, { recursive: true });

const settings = {
  schemaVersion: 4,
  activeProviderId: 'ollama-local',
  providers: [
    {
      id: 'ollama-local',
      name: `Ollama (${MODEL})`,
      type: 'openai-compatible',
      enabled: true,
      baseUrl: BASE,
      apiKey: '',
      model: MODEL,
      timeoutMs: 180000,
      maxTokens: 4096,
      temperature: 0.2,
      systemPrompt: '',
      userPromptTemplate: '',
      headers: {},
    },
  ],
  defaultDisplayMode: 'bilingual',
  autoTranslate: false,
  blacklist: [],
  defaultSourceLanguage: 'auto',
  defaultTargetLanguage: '简体中文',
  cacheEnabled: true,
  minTextLength: 6,
  imageTranslate: { enabled: true, trigger: 'both', engine: 'tesseract-wasm', maxEdgePx: 4096 },
};

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
  }
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
          reject(new Error(`CDP timeout: ${method}`));
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
    if (exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(exceptionDetails)}`);
    return result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(port, predicate, label, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const found = targets.find(predicate);
      if (found) return found;
    } catch {
      /* port not up */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  await fetch(`http://127.0.0.1:${PORT}/json/version`);
  console.error(`Port ${PORT} is already in use. Close that Edge instance or change PORT.`);
  process.exit(2);
} catch {
  /* free */
}

const child = spawn(
  EDGE,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${dist}`,
    `--disable-extensions-except=${dist}`,
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://en.wikipedia.org/wiki/Translation',
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

const sw = await waitFor(
  PORT,
  (t) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
  'PolyPage service worker',
);
const id = sw.url.match(/chrome-extension:\/\/([a-z]+)\//)?.[1];
if (!id) throw new Error(`cannot parse extension id from ${sw.url}`);

const ext = await CDP.connect(sw.webSocketDebuggerUrl);
await ext.send('Runtime.enable');
const saved = await ext.eval(
  `chrome.runtime.sendMessage({ type: 'save-settings', settings: ${JSON.stringify(settings)} })`,
);
if (!saved?.ok) throw new Error(`save-settings failed: ${JSON.stringify(saved)}`);
const summary = await ext.eval(`chrome.runtime.sendMessage({ type: 'get-settings-summary' })`);
ext.close();

console.log(`Edge launched with profile: ${profile}`);
console.log(`Extension id: ${id}`);
console.log(`Provider: ${summary?.providerName}  model=${MODEL}  ${BASE}`);
console.log('Popup the toolbar icon, then Translate on the Wikipedia tab.');
console.log('Image OCR uses tesseract-wasm (this model is text-only). ASR needs a Whisper endpoint.');
