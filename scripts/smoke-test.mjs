/**
 * End-to-end smoke test (headless Edge):
 *  - serves a test page (port 8123) and a mock OpenAI-compatible API (8124),
 *  - launches headless Edge with dist/ loaded as an unpacked extension,
 *  - opens the extension's options page and configures a provider pointing
 *    at the mock API (chrome.storage),
 *  - drives the content script through the real runtime/tabs message pipeline,
 *  - asserts bilingual blocks appear with the mocked translations,
 *  - asserts mode switching and restore behave correctly.
 *
 * Note: branded Chrome ignores --load-extension, so Edge is used.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const PORT_PAGE = 8123;
const PORT_API = 8124;
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/* ------------------------------- test fixtures ------------------------------- */

const P1 = 'The quick brown fox jumps over the lazy dog near the river bank.';
const P2 = 'Machine learning models require large amounts of training data.';
const P3 = 'Open source software has changed the way companies build products.';

const testPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Smoke</title></head>
<body>
  <article>
    <h1>A test article heading long enough to translate</h1>
    <p id="p1">${P1}</p>
    <p id="p2">${P2}</p>
    <p id="p3">${P3}</p>
  </article>
</body></html>`;

function startPageServer() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(testPage);
    });
    server.listen(PORT_PAGE, '127.0.0.1', () => resolve(server));
  });
}

function startMockApi() {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests++;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end('{}');
      }
      const user = parsed.messages?.filter((m) => m.role === 'user').pop()?.content ?? '';
      // Batch requests carry numbered lines "1) text"; singles carry plain text.
      const numbered = [...user.matchAll(/^\d+\)\s+(.*)$/gm)].map((m) => m[1]);
      const texts = numbered.length > 0 ? numbered : [user.trim()];
      const translations = texts.map((t) => `[译] ${t}`);
      const content = numbered.length > 0 ? JSON.stringify(translations) : translations[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT_API, '127.0.0.1', () => resolve({ server, count: () => requests }));
  });
}

/* --------------------------------- CDP client -------------------------------- */

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
    return result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitForTarget(port, predicate, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const found = targets.find(predicate);
      if (found) return found;
    } catch (e) {
      lastError = e; // DevTools port not up yet
    }
    await sleep(400);
  }
  throw new Error(
    `timed out waiting for target: ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`,
  );
}

/** Locate our extension by finding the SW target that serves background.js. */
async function findExtensionId(port) {
  const sw = await waitForTarget(
    port,
    (t) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
    'our service worker',
    30000,
  );
  const m = sw.url.match(/chrome-extension:\/\/([a-z]+)\//);
  if (!m) throw new Error(`cannot parse extension id from ${sw.url}`);
  return m[1];
}

/* ----------------------------------- main ------------------------------------ */

// Refuse to run against a stale browser from a previous run.
try {
  await fetch('http://127.0.0.1:9222/json/version');
  console.error('ABORT: something is already listening on port 9222 (stale browser?). Kill it first.');
  process.exit(2);
} catch {
  // port free — good
}

function killTree(proc) {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    // Belt and braces: kill whatever still listens on the debug port.
    for (let i = 0; i < 10; i++) {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
      const line = out.split('\n').find((l) => l.includes(':9222') && l.includes('LISTENING'));
      if (!line) break;
      const pid = line.trim().split(/\s+/).pop();
      if (pid) spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' });
    }
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

const pageServer = await startPageServer();
const mock = await startMockApi();

const profileDir = await mkdtemp(path.join(tmpdir(), 'polypage-smoke-'));
const browserArgs = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-sync',
  '--load-extension=' + distDir,
  '--remote-debugging-port=9222',
  '--user-data-dir=' + profileDir,
  `http://127.0.0.1:${PORT_PAGE}/`,
];
const browser = spawn(BROWSER, browserArgs, { stdio: 'ignore' });

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  console.log('Waiting for extension service worker...');
  const extensionId = await findExtensionId(9222);
  check('extension loaded (service worker registered)', true);

  // Open the extension's options page via the browser-level debugger.
  const version = await fetchJson('http://127.0.0.1:9222/json/version');
  const browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await browserCdp.send('Target.createTarget', { url: optionsUrl });
  browserCdp.close();

  const optionsTarget = await waitForTarget(
    9222,
    (t) => t.type === 'page' && t.url.startsWith(optionsUrl),
    'options page',
  );
  const ext = await CDP.connect(optionsTarget.webSocketDebuggerUrl);
  await ext.send('Runtime.enable');

  // Configure the extension to use the mock API.
  const settingsJson = JSON.stringify({
    schemaVersion: 1,
    activeProviderId: 'mock',
    providers: [
      {
        id: 'mock',
        name: 'Mock LLM',
        type: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${PORT_API}/v1`,
        apiKey: 'test-key',
        model: 'mock-model',
        sourceLanguage: 'English',
        targetLanguage: 'Chinese',
        timeoutMs: 15000,
        maxBatchItems: 10,
        maxBatchChars: 6000,
        systemPrompt: 'Translate. Output only translations.',
        userPromptTemplate:
          'Translate the following text from {{sourceLanguage}} to {{targetLanguage}}:\n\n{{text}}',
        temperature: 0.2,
        maxTokens: 4096,
        headers: {},
        enabled: true,
      },
    ],
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [],
    defaultSourceLanguage: 'auto',
    defaultTargetLanguage: '简体中文',
    cacheEnabled: false,
    minTextLength: 6,
  });
  // Wait for onInstalled to finish writing defaults, then overwrite through the
  // real save-settings message (which also refreshes the SW's settings cache).
  await ext.eval(`
    (async () => {
      for (let i = 0; i < 50; i++) {
        const data = await chrome.storage.local.get('settings');
        if (data.settings) return 'defaults-written';
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('onInstalled never wrote default settings');
    })()`);
  const saveRes = await ext.eval(
    `chrome.runtime.sendMessage({ type: 'save-settings', settings: ${settingsJson} })`,
  );
  check('save-settings accepted', saveRes?.ok === true, JSON.stringify(saveRes));

  // Boot the popup page inside the extension and verify its UI initializes.
  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  const versionForPopup = await fetchJson('http://127.0.0.1:9222/json/version');
  const browserCdp2 = await CDP.connect(versionForPopup.webSocketDebuggerUrl);
  await browserCdp2.send('Target.createTarget', { url: popupUrl });
  browserCdp2.close();
  const popupTarget = await waitForTarget(
    9222,
    (t) => t.type === 'page' && t.url.startsWith(popupUrl),
    'popup page',
  );
  const popup = await CDP.connect(popupTarget.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  let popupModes = 0;
  for (let i = 0; i < 20; i++) {
    popupModes = await popup.eval(`document.querySelectorAll('.mode-item').length`);
    if (popupModes === 5) break;
    await sleep(300);
  }
  check('popup UI initialized (5 display modes rendered)', popupModes === 5, `modes=${popupModes}`);
  const popupProvider = await popup.eval(
    `document.getElementById('info-provider')?.textContent ?? ''`,
  );
  check('popup shows active provider', popupProvider.includes('Mock LLM'), popupProvider);
  popup.close();
  const summary = await ext.eval(
    `chrome.runtime.sendMessage({ type: 'get-settings-summary' })`,
  );
  check('background answers messages', summary?.providerName === 'Mock LLM', JSON.stringify(summary));

  // Helper expression: send a command to whichever tab hosts the content script.
  const sendToTab = (cmdJson) => `
    (async () => {
      const tabs = await chrome.tabs.query({});
      let lastErr = null;
      for (const t of tabs) {
        try { return await chrome.tabs.sendMessage(t.id, ${cmdJson}); }
        catch (e) { lastErr = e; }
      }
      throw lastErr ?? new Error('no tab');
    })()`;

  // Wait until the content script answers.
  let state = null;
  for (let i = 0; i < 25; i++) {
    try {
      state = await ext.eval(sendToTab(`{ type: 'wt:get-state' }`), 5000);
      break;
    } catch {
      await sleep(400);
    }
  }
  check('content script injected', state?.injected === true, JSON.stringify(state));
  check('scanner found paragraphs', (state?.total ?? 0) >= 4, `total=${state?.total}`);

  // Connect to the test page to inspect the DOM.
  const pageTarget = await waitForTarget(
    9222,
    (t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT_PAGE}`),
    'test page',
  );
  const page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');

  // Trigger translation (bilingual default mode).
  await ext.eval(sendToTab(`{ type: 'wt:translate' }`), 5000);

  // Poll for bilingual blocks (h1 + 3 paragraphs).
  let blocks = [];
  for (let i = 0; i < 30; i++) {
    blocks = await page.eval(
      `[...document.querySelectorAll('.wt-bilingual-block')].map(b => b.textContent)`,
    );
    if (blocks.length >= 4 && blocks.every((t) => t.includes('[译]'))) break;
    await sleep(500);
  }
  check('bilingual blocks inserted', blocks.length >= 4, `got ${blocks.length}`);
  check(
    'translations rendered from mock API',
    blocks.some((t) => t.includes('[译] Machine learning models')),
    JSON.stringify(blocks),
  );
  const p1 = await page.eval(`document.getElementById('p1').textContent`);
  check('original text preserved alongside translation', p1 === P1, JSON.stringify(p1));

  const midState = await ext.eval(sendToTab(`{ type: 'wt:get-state' }`));
  check('state reports translated count', (midState?.translated ?? 0) >= 4, JSON.stringify(midState));
  check('no failed items', (midState?.failed ?? -1) === 0, JSON.stringify(midState));
  check('mock API was actually called', mock.count() >= 1, `calls=${mock.count()}`);

  // Switch to translated mode, then hover mode, then restore.
  await ext.eval(sendToTab(`{ type: 'wt:set-mode', mode: 'translated' }`), 5000);
  await sleep(600);
  const bodyText = await page.eval(`document.getElementById('p2').textContent`);
  check('translated mode swaps body text', bodyText.includes('[译]'), JSON.stringify(bodyText));

  await ext.eval(sendToTab(`{ type: 'wt:set-mode', mode: 'translated_hover_original' }`), 5000);
  const hoverState = await ext.eval(sendToTab(`{ type: 'wt:get-state' }`));
  check('hover mode switches without refetch', hoverState?.mode === 'translated_hover_original');
  check(
    'hover mode still shows translation in body',
    (await page.eval(`document.getElementById('p3').textContent`)).includes('[译]'),
  );

  // Simulate a hover: tooltip must appear in a Shadow DOM host with the ORIGINAL text.
  await page.eval(`document.querySelector('p[data-wt-id]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await sleep(400);
  const tooltipText = await page.eval(
    `document.querySelector('.wt-tooltip-host')?.shadowRoot?.textContent ?? null`,
  );
  check(
    'hover tooltip shows original text in Shadow DOM',
    typeof tooltipText === 'string' && tooltipText.includes(P1),
    JSON.stringify(tooltipText),
  );
  const tooltipInPageDom = await page.eval(
    `document.querySelector('.wt-tooltip-host')?.shadowRoot?.querySelector('.wt-tooltip') !== null`,
  );
  check('tooltip content isolated inside Shadow DOM', tooltipInPageDom === true);

  await ext.eval(sendToTab(`{ type: 'wt:restore' }`), 5000);
  let afterBlocks = -1;
  for (let i = 0; i < 20; i++) {
    afterBlocks = await page.eval(`document.querySelectorAll('.wt-bilingual-block').length`);
    if (afterBlocks === 0) break;
    await sleep(300);
  }
  const restoredP2 = await page.eval(`document.getElementById('p2').textContent`);
  check('restore removes bilingual blocks', afterBlocks === 0, `blocks=${afterBlocks}`);
  check('original fully restorable', restoredP2 === P2, JSON.stringify(restoredP2));

  const finalState = await ext.eval(sendToTab(`{ type: 'wt:get-state' }`));
  check('state resets after restore', finalState?.active === false, JSON.stringify(finalState));
} catch (e) {
  failures++;
  console.log(`  FAIL  smoke test crashed — ${e.message}`);
} finally {
  killTree(browser);
  pageServer.close();
  mock.server.close();
}

console.log(failures === 0 ? 'SMOKE TEST: ALL PASSED' : `SMOKE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
