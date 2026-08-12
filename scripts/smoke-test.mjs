/**
 * End-to-end smoke test (headless Edge), 2.0 edition.
 *
 *  - serves fixture pages (port 8123; cross-origin port 8125) and a mock
 *    OpenAI-compatible API (8124, with SSE streaming support);
 *  - launches headless Edge with dist/ loaded as an unpacked extension;
 *  - drives the content script through the real runtime/tabs pipeline;
 *  - 1.0 assertions stay intact (zero regression, spec 2.0 §0 item 1);
 *  - 2.0 additions: inline mode, Shadow DOM, iframes + frame aggregation,
 *    site rules, selection translate, SSE streaming hover, bilingual export,
 *    the REAL .NET gateway via Native Messaging, and failover chains.
 *
 * Note: branded Chrome ignores --load-extension, so Edge is used.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const PORT_PAGE = 8123;
const PORT_API = 8124;
const PORT_XORIGIN = 8125;
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GATEWAY_EXE = path.join(
  root,
  'native-host/PolyPage.Gateway/bin/Release/net8.0/win-x64/publish/PolyPage.Gateway.exe',
);
const HOST_NAME = 'com.skymly.polypage.gateway';
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const GATEWAY_DIR = path.join(LOCAL_APP_DATA, 'PolyPage');
const HOST_MANIFEST = path.join(GATEWAY_DIR, `${HOST_NAME}.json`);

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

const shadowPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Shadow</title></head>
<body>
  <p id="outside">A normal paragraph outside any shadow root lives here.</p>
  <div id="shadow-host"></div>
  <script>
    const host = document.getElementById('shadow-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const p = document.createElement('p');
    p.id = 'shadow-p';
    p.textContent = 'This paragraph lives inside an open shadow root element.';
    shadow.appendChild(p);
  </script>
</body></html>`;

const iframeChildPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Frame child</title></head>
<body>
  <p id="frame-p1">The iframe child paragraph contains enough text to translate.</p>
  <p id="frame-p2">Another frame paragraph with plenty of translatable content.</p>
</body></html>`;

const iframesPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Iframes</title></head>
<body>
  <p id="top-p">The top-level page paragraph sits next to two embedded frames.</p>
  <iframe id="same-origin" src="http://127.0.0.1:${PORT_PAGE}/iframe-child.html" width="400" height="200"></iframe>
  <iframe id="cross-origin" src="http://127.0.0.1:${PORT_XORIGIN}/iframe-child.html" width="400" height="200"></iframe>
</body></html>`;

const selectionPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Selection</title></head>
<body>
  <p id="sel-p">Selecting this sentence should reveal a floating translate button nearby.</p>
</body></html>`;

const inlinePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Inline</title></head>
<body>
  <p id="in1">Lead text with <strong>bold markup</strong> and <a href="#">a hyperlink</a> inside the paragraph.</p>
  <p id="in2">A second paragraph that stays plain but long enough for translation.</p>
</body></html>`;

function startPageServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      const pages = {
        '/': testPage,
        '/shadow.html': shadowPage,
        '/iframes.html': iframesPage,
        '/iframe-child.html': iframeChildPage,
        '/selection.html': selectionPage,
        '/inline.html': inlinePage,
      };
      const html = pages[url.split('?')[0]];
      if (!html) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(PORT_PAGE, '127.0.0.1', () => resolve(server));
  });
}

function startCrossOriginServer() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(iframeChildPage);
    });
    server.listen(PORT_XORIGIN, '127.0.0.1', () => resolve(server));
  });
}

function startMockApi() {
  let requests = 0;
  let sseRequests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests++;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end('{}');
      }

      // 2.0: gateway HttpBackend endpoint (custom JSON shape).
      if ((req.url ?? '').startsWith('/custom-translate')) {
        const texts = Array.isArray(parsed.q) ? parsed.q : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ data: { translations: texts.map((t) => `[gw] ${t}`) } }),
        );
      }

      const user = parsed.messages?.filter((m) => m.role === 'user').pop()?.content ?? '';
      const numbered = [...user.matchAll(/^\d+\)\s+(.*)$/gm)].map((m) => m[1]);
      // Single-item requests arrive wrapped in the user prompt template;
      // extract the trailing text so translations mirror real providers.
      const singleMatch = user.match(/Translate the following text from [^:]+:\s*\n\n([\s\S]+)$/);
      const texts =
        numbered.length > 0 ? numbered : [singleMatch ? singleMatch[1].trim() : user.trim()];
      const translations = texts.map((t) => `[译] ${t}`);

      // 2.0: SSE streaming response (spec 2.0 §7.3).
      if (parsed.stream === true) {
        sseRequests++;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const full = translations[0];
        // Emit in growing chunks so the smoke test can observe increments.
        const chunks = [full.slice(0, 6), full.slice(6, 20), full.slice(20)];
        for (const chunk of chunks) {
          if (chunk === '') continue;
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
          );
          await sleep(40);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const content = numbered.length > 0 ? JSON.stringify(translations) : translations[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT_API, '127.0.0.1', () =>
      resolve({ server, count: () => requests, sseCount: () => sseRequests }),
    );
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

async function waitForTarget(port, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
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
const xoriginServer = await startCrossOriginServer();
const mock = await startMockApi();

/* ---------------------- gateway installation (2.0 pillar A) ------------------- */

let gatewayInstalled = false;
const gatewayConfigPath = path.join(await mkdtemp(path.join(tmpdir(), 'polypage-smoke-gw-')), 'gateway.json');
await writeFile(
  gatewayConfigPath,
  JSON.stringify({
    defaultBackend: 'stub-http',
    ollama: [],
    http: [
      {
        id: 'stub-http',
        name: 'Smoke stub backend',
        url: `http://127.0.0.1:${PORT_API}/custom-translate`,
        method: 'POST',
        bodyTemplate: '{ "q": {{texts}}, "from": "{{sourceLanguage}}", "to": "{{targetLanguage}}" }',
        responsePath: 'data.translations',
        apiKey: '',
        headers: {},
        timeoutMs: 10000,
      },
    ],
  }),
);

// Install the gateway BEFORE launching the browser. allowed_origins gets the
// real extension id once the service worker target reveals it (the manifest
// file is re-read by the browser on connectNative).
let gatewayExistedBefore = existsSync(HOST_MANIFEST);
if (existsSync(GATEWAY_EXE)) {
  const install = spawnSync(GATEWAY_EXE, ['--install', '--allow', 'chrome-extension://placeholder/'], {
    encoding: 'utf8',
  });
  gatewayInstalled = install.status === 0;
  console.log(gatewayInstalled ? 'Gateway installed for smoke test.' : `Gateway install failed: ${install.stderr}`);
} else {
  console.log(`WARN: gateway exe not found at ${GATEWAY_EXE} — native-host phases will fail.`);
}

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
const browser = spawn(BROWSER, browserArgs, {
  stdio: 'ignore',
  env: { ...process.env, POLYPAGE_GATEWAY_CONFIG: gatewayConfigPath },
});

let failures = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------------- settings helper ------------------------------ */

function providerOpenAi(id, name, baseUrl) {
  return {
    id,
    name,
    type: 'openai-compatible',
    baseUrl,
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
  };
}

function settingsPayload(overrides) {
  return JSON.stringify({
    schemaVersion: 2,
    activeProviderId: 'mock',
    providers: [providerOpenAi('mock', 'Mock LLM', `http://127.0.0.1:${PORT_API}/v1`)],
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [],
    defaultSourceLanguage: 'auto',
    defaultTargetLanguage: '简体中文',
    cacheEnabled: false,
    minTextLength: 6,
    glossary: [],
    glossaryVersion: 0,
    siteRules: [],
    failoverChain: [],
    selectionTranslate: 'always',
    inlineBudget: 300,
    viewportBudget: 500,
    ...overrides,
  });
}

let ext = null;
let extensionId = null;

/** Send a command to the content script of the tab whose URL matches prefix. */
function sendToTabWithUrl(urlPrefix, cmdJson) {
  return `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url ?? '').startsWith(${JSON.stringify(urlPrefix)}));
      if (!tab) throw new Error('no tab matching ${urlPrefix.replace(/'/g, '')}');
      return await chrome.tabs.sendMessage(tab.id, ${cmdJson});
    })()`;
}

/** Open a fixture page in a new tab. */
async function openPage(browserCdp, url) {
  await browserCdp.send('Target.createTarget', { url });
}

async function pageFor(urlPrefix) {
  const target = await waitForTarget(
    9222,
    (t) => t.type === 'page' && t.url.startsWith(urlPrefix),
    urlPrefix,
  );
  const client = await CDP.connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  return client;
}

async function closePage(browserCdp, urlPrefix) {
  const targets = await fetchJson('http://127.0.0.1:9222/json');
  for (const t of targets.filter((x) => x.type === 'page' && x.url.startsWith(urlPrefix))) {
    try {
      await browserCdp.send('Target.closeTarget', { targetId: t.id });
    } catch {
      /* ignore */
    }
  }
  await sleep(300);
}

async function saveSettingsThroughExtension(payload) {
  const res = await ext.eval(
    `chrome.runtime.sendMessage({ type: 'save-settings', settings: ${payload} })`,
  );
  return res?.ok === true;
}

try {
  console.log('Waiting for extension service worker...');
  extensionId = await findExtensionId(9222);
  check('extension loaded (service worker registered)', true);

  // Now that we know the extension id, refresh the host manifest's
  // allowed_origins so connectNative will accept it.
  if (gatewayInstalled) {
    try {
      const manifest = JSON.parse(await readFile(HOST_MANIFEST, 'utf8'));
      manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
      await writeFile(HOST_MANIFEST, JSON.stringify(manifest, null, 2));
    } catch (e) {
      console.log(`WARN: could not refresh host manifest origins: ${e.message}`);
    }
  }

  // Open the extension's options page via the browser-level debugger.
  const version = await fetchJson('http://127.0.0.1:9222/json/version');
  const browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  await openPage(browserCdp, optionsUrl);

  const optionsTarget = await waitForTarget(
    9222,
    (t) => t.type === 'page' && t.url.startsWith(optionsUrl),
    'options page',
  );
  ext = await CDP.connect(optionsTarget.webSocketDebuggerUrl);
  await ext.send('Runtime.enable');

  // Wait for onInstalled to finish writing defaults, then overwrite through
  // the real save-settings message (which also refreshes the SW's settings cache).
  await ext.eval(`
    (async () => {
      for (let i = 0; i < 50; i++) {
        const data = await chrome.storage.local.get('settings');
        if (data.settings) return 'defaults-written';
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('onInstalled never wrote default settings');
    })()`);
  check('save-settings accepted', await saveSettingsThroughExtension(settingsPayload({})));

  // Boot the popup page inside the extension and verify its UI initializes.
  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  await openPage(browserCdp, popupUrl);
  const popup = await pageFor(popupUrl);
  let popupModes = 0;
  for (let i = 0; i < 20; i++) {
    popupModes = await popup.eval(`document.querySelectorAll('.mode-item').length`);
    if (popupModes === 6) break; // 2.0: six display modes (adds inline)
    await sleep(300);
  }
  check('popup UI initialized (6 display modes rendered)', popupModes === 6, `modes=${popupModes}`);
  const popupProvider = await popup.eval(
    `document.getElementById('info-provider')?.textContent ?? ''`,
  );
  check('popup shows active provider', popupProvider.includes('Mock LLM'), popupProvider);
  await closePage(browserCdp, popupUrl);
  popup.close();
  /* ============================ 1.0 baseline suite ============================ */

  const pageUrl = `http://127.0.0.1:${PORT_PAGE}/`;
  let state = null;
  for (let i = 0; i < 25; i++) {
    try {
      state = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`), 5000);
      break;
    } catch {
      await sleep(400);
    }
  }
  check('content script injected', state?.injected === true, JSON.stringify(state));
  check('scanner found paragraphs', (state?.total ?? 0) >= 4, `total=${state?.total}`);

  const page = await pageFor(pageUrl);

  // Trigger translation (bilingual default mode).
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);

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

  const midState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
  check('state reports translated count', (midState?.translated ?? 0) >= 4, JSON.stringify(midState));
  check('no failed items', (midState?.failed ?? -1) === 0, JSON.stringify(midState));
  check('mock API was actually called', mock.count() >= 1, `calls=${mock.count()}`);

  // Switch to translated mode, then hover mode, then restore.
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:set-mode', mode: 'translated' }`), 5000);
  await sleep(600);
  const bodyText = await page.eval(`document.getElementById('p2').textContent`);
  check('translated mode swaps body text', bodyText.includes('[译]'), JSON.stringify(bodyText));

  await ext.eval(
    sendToTabWithUrl(pageUrl, `{ type: 'wt:set-mode', mode: 'translated_hover_original' }`),
    5000,
  );
  const hoverState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
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

  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);
  let afterBlocks = -1;
  for (let i = 0; i < 20; i++) {
    afterBlocks = await page.eval(`document.querySelectorAll('.wt-bilingual-block').length`);
    if (afterBlocks === 0) break;
    await sleep(300);
  }
  const restoredP2 = await page.eval(`document.getElementById('p2').textContent`);
  check('restore removes bilingual blocks', afterBlocks === 0, `blocks=${afterBlocks}`);
  check('original fully restorable', restoredP2 === P2, JSON.stringify(restoredP2));

  const finalState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
  check('state resets after restore', finalState?.active === false, JSON.stringify(finalState));

  /* ============================== 2.0 site rules ============================== */

  // Rule for 127.0.0.1 excludes #p3 from translation.
  const rulesSettings = settingsPayload({
    siteRules: [
      {
        id: 'smoke-rule',
        match: ['127.0.0.1'],
        excludeSelectors: ['#p3'],
        enabled: true,
      },
    ],
  });
  check('site rules saved', await saveSettingsThroughExtension(rulesSettings));
  await page.eval(`location.reload()`);
  await sleep(1500);
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
  let ruleBlocks = 0;
  let p3Translated = null;
  for (let i = 0; i < 30; i++) {
    ruleBlocks = await page.eval(`document.querySelectorAll('.wt-bilingual-block').length`);
    p3Translated = await page.eval(
      `!!document.getElementById('p3')?.closest('article')?.querySelector('.wt-bilingual-block[data-wt-id]') && document.querySelector('[data-wt-id] + .wt-bilingual-block') !== null`,
    );
    if (ruleBlocks >= 3) break;
    await sleep(500);
  }
  const p3HasBlock = await page.eval(`
    (() => {
      const p3 = document.getElementById('p3');
      const next = p3?.nextElementSibling;
      return !!(next && next.classList.contains('wt-bilingual-block'));
    })()`);
  const p1HasBlock = await page.eval(`
    (() => {
      const p1 = document.getElementById('p1');
      const next = p1?.nextElementSibling;
      return !!(next && next.classList.contains('wt-bilingual-block'));
    })()`);
  check('site rule include: p1 still translated', p1HasBlock === true);
  check('site rule exclude: #p3 skipped', p3HasBlock === false, `p3HasBlock=${p3HasBlock}`);
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);
  // Reset rules for later phases.
  check('site rules reset', await saveSettingsThroughExtension(settingsPayload({})));

  /* ============================ 2.0 inline mode ============================== */

  const inlineUrl = `http://127.0.0.1:${PORT_PAGE}/inline.html`;
  await openPage(browserCdp, inlineUrl);
  const inlinePageClient = await pageFor(inlineUrl);
  await sleep(800);
  await ext.eval(sendToTabWithUrl(inlineUrl, `{ type: 'wt:set-mode', mode: 'inline' }`), 5000);

  let dstTexts = [];
  for (let i = 0; i < 30; i++) {
    dstTexts = await inlinePageClient.eval(
      `[...document.querySelectorAll('.wt-inline-dst')].map(s => s.textContent)`,
    );
    if (dstTexts.length >= 2 && dstTexts.every((t) => t.includes('[译]'))) break;
    await sleep(500);
  }
  check('inline mode inserts dst spans', dstTexts.length >= 2, JSON.stringify(dstTexts));
  check(
    'inline translations come from mock API',
    dstTexts.some((t) => t.includes('[译]')),
    JSON.stringify(dstTexts),
  );
  const strongPreserved = await inlinePageClient.eval(
    `document.querySelector('#in1 strong') !== null && document.querySelector('#in1 a') !== null`,
  );
  check('inline mode preserves inline markup (strong/a)', strongPreserved === true);
  const srcPreserved = await inlinePageClient.eval(
    `[...document.querySelectorAll('.wt-inline-src')].map(s => s.textContent).join(' ')`,
  );
  check('inline mode keeps original text visible', srcPreserved.includes('Lead text with'));

  // Restore must fully undo inline spans.
  await ext.eval(sendToTabWithUrl(inlineUrl, `{ type: 'wt:restore' }`), 5000);
  await sleep(400);
  const inlineAfter = await inlinePageClient.eval(
    `document.querySelectorAll('.wt-inline-src, .wt-inline-dst').length`,
  );
  if (inlineAfter !== 0) {
    const leftover = await inlinePageClient.eval(
      `[...document.querySelectorAll('.wt-inline-src, .wt-inline-dst')]
        .map((s) => s.parentElement?.id + '|' + s.className + '|' + s.textContent.slice(0, 40))`,
    );
    console.log('  DEBUG inline leftovers:', JSON.stringify(leftover));
  }
  const inlineP1Restored = await inlinePageClient.eval(
    `document.getElementById('in1').textContent`,
  );
  check('inline restore removes all spans', inlineAfter === 0, `left=${inlineAfter}`);
  check(
    'inline restore recovers original markup',
    inlineP1Restored.includes('bold markup') &&
      (await inlinePageClient.eval(`document.querySelector('#in1 strong') !== null`)) === true,
  );
  await closePage(browserCdp, inlineUrl);
  inlinePageClient.close();
  /* ============================ 2.0 Shadow DOM =============================== */

  const shadowUrl = `http://127.0.0.1:${PORT_PAGE}/shadow.html`;
  await openPage(browserCdp, shadowUrl);
  const shadowClient = await pageFor(shadowUrl);
  await sleep(800);
  const shadowStateBefore = await ext.eval(
    sendToTabWithUrl(shadowUrl, `{ type: 'wt:get-state' }`),
  );
  check(
    'scanner descends into open shadow roots',
    (shadowStateBefore?.total ?? 0) >= 2,
    `total=${shadowStateBefore?.total}`,
  );
  await ext.eval(sendToTabWithUrl(shadowUrl, `{ type: 'wt:translate' }`), 5000);
  let shadowBlocks = 0;
  let shadowBlockText = '';
  for (let i = 0; i < 30; i++) {
    shadowBlocks = await shadowClient.eval(`
      (() => {
        const root = document.getElementById('shadow-host')?.shadowRoot;
        return root ? root.querySelectorAll('.wt-bilingual-block').length : 0;
      })()`);
    shadowBlockText = await shadowClient.eval(`
      (() => {
        const root = document.getElementById('shadow-host')?.shadowRoot;
        return root ? (root.querySelector('.wt-bilingual-block')?.textContent ?? '') : '';
      })()`);
    if (shadowBlocks >= 1 && shadowBlockText.includes('[译]')) break;
    await sleep(500);
  }
  check('shadow root paragraph translated', shadowBlocks >= 1, `blocks=${shadowBlocks}`);
  check(
    'shadow translation comes from mock API',
    shadowBlockText.includes('[译]') && shadowBlockText.includes('shadow root'),
    JSON.stringify(shadowBlockText),
  );
  const shadowStyleInjected = await shadowClient.eval(`
    document.getElementById('shadow-host')?.shadowRoot?.querySelector('style[data-wt-shadow-style]') !== null`);
  check('shadow root received style clone', shadowStyleInjected === true);
  await ext.eval(sendToTabWithUrl(shadowUrl, `{ type: 'wt:restore' }`), 5000);
  await closePage(browserCdp, shadowUrl);
  shadowClient.close();

  /* ========================== 2.0 iframes + aggregation ======================= */

  const iframesUrl = `http://127.0.0.1:${PORT_PAGE}/iframes.html`;
  await openPage(browserCdp, iframesUrl);
  await sleep(1200); // let both frames load + inject
  await ext.eval(sendToTabWithUrl(iframesUrl, `{ type: 'wt:translate' }`), 5000);

  // Frame aggregation: background should hear from top + both frames.
  const iframesTabId = await ext.eval(`
    (async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url ?? '').startsWith(${JSON.stringify(iframesUrl)}));
      return tab?.id ?? -1;
    })()`);
  let frames = [];
  for (let i = 0; i < 30; i++) {
    const res = await ext.eval(
      `chrome.runtime.sendMessage({ v: 2, type: 'get-frame-states', tabId: ${iframesTabId} })`,
    );
    frames = res?.frames ?? [];
    if (frames.length >= 3 && frames.every((f) => f.state.active)) break;
    await sleep(500);
  }
  check('frame aggregation sees 3 frames', frames.length >= 3, `frames=${frames.length}`);
  const aggregatedTotal = frames.reduce((sum, f) => sum + (f.state.total ?? 0), 0);
  check('aggregated totals cover all frames', aggregatedTotal >= 5, `total=${aggregatedTotal}`);

  // Same-origin iframe: inspect through contentDocument.
  const iframesClient = await pageFor(iframesUrl);
  let sameOriginBlocks = 0;
  for (let i = 0; i < 30; i++) {
    sameOriginBlocks = await iframesClient.eval(`
      document.getElementById('same-origin')?.contentDocument?.querySelectorAll('.wt-bilingual-block').length ?? 0`);
    if (sameOriginBlocks >= 2) break;
    await sleep(500);
  }
  check('same-origin iframe translated', sameOriginBlocks >= 2, `blocks=${sameOriginBlocks}`);

  // Cross-origin iframe: prefer direct CDP inspection of the OOPIF target;
  // fall back to the background's per-frame state (translated count >= 2)
  // which also proves the frame ran the translation end-to-end.
  let xoriginOk = false;
  const xoriginTarget = await waitForTarget(
    9222,
    (t) => (t.type === 'iframe' || t.type === 'page') && t.url.startsWith(`http://127.0.0.1:${PORT_XORIGIN}`),
    'cross-origin iframe target',
    15000,
  ).catch(() => null);
  if (xoriginTarget) {
    const xclient = await CDP.connect(xoriginTarget.webSocketDebuggerUrl);
    await xclient.send('Runtime.enable');
    for (let i = 0; i < 30; i++) {
      const n = await xclient.eval(`document.querySelectorAll('.wt-bilingual-block').length`).catch(() => 0);
      if (n >= 2) {
        xoriginOk = true;
        break;
      }
      await sleep(500);
    }
    xclient.close();
  }
  if (!xoriginOk) {
    for (let i = 0; i < 20; i++) {
      const res = await ext.eval(
        `chrome.runtime.sendMessage({ v: 2, type: 'get-frame-states', tabId: ${iframesTabId} })`,
      );
      const xframe = (res?.frames ?? []).find((f) => (f.state.frameUrl ?? '').startsWith(`http://127.0.0.1:${PORT_XORIGIN}`));
      if (xframe && xframe.state.translated >= 2 && xframe.state.failed === 0) {
        xoriginOk = true;
        break;
      }
      await sleep(500);
    }
  }
  check('cross-origin iframe translated (all_frames)', xoriginOk);

  // Restore on the top frame must broadcast restore to all frames.
  await ext.eval(sendToTabWithUrl(iframesUrl, `{ type: 'wt:restore' }`), 5000);
  let sameOriginAfter = -1;
  for (let i = 0; i < 20; i++) {
    sameOriginAfter = await iframesClient.eval(`
      document.getElementById('same-origin')?.contentDocument?.querySelectorAll('.wt-bilingual-block').length ?? -1`);
    if (sameOriginAfter === 0) break;
    await sleep(400);
  }
  check('restore broadcasts into frames', sameOriginAfter === 0, `blocks=${sameOriginAfter}`);
  await closePage(browserCdp, iframesUrl);
  iframesClient.close();

  /* =========================== 2.0 selection translate ======================== */

  const selectionUrl = `http://127.0.0.1:${PORT_PAGE}/selection.html`;
  await openPage(browserCdp, selectionUrl);
  const selectionClient = await pageFor(selectionUrl);
  await sleep(800);
  await selectionClient.eval(`
    (() => {
      const p = document.getElementById('sel-p');
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 60 }));
    })()`);
  let selBtnVisible = false;
  for (let i = 0; i < 20; i++) {
    selBtnVisible = await selectionClient.eval(`
      (() => {
        const host = document.querySelector('.wt-selection-host');
        const btn = host?.shadowRoot?.querySelector('.wt-sel-btn');
        return !!btn && btn.style.display !== 'none';
      })()`);
    if (selBtnVisible) break;
    await sleep(300);
  }
  check('selection shows floating translate button', selBtnVisible === true);

  // Click the button inside the shadow root; panel must show the translation.
  await selectionClient.eval(`
    document.querySelector('.wt-selection-host')?.shadowRoot?.querySelector('.wt-sel-btn')?.click()`);
  let panelText = '';
  for (let i = 0; i < 30; i++) {
    panelText = await selectionClient.eval(`
      document.querySelector('.wt-selection-host')?.shadowRoot?.querySelector('.wt-sel-text')?.textContent ?? ''`);
    if (panelText.includes('[译]')) break;
    await sleep(400);
  }
  check('selection panel shows translation', panelText.includes('[译]'), JSON.stringify(panelText));
  const panelIsolated = await selectionClient.eval(`
    (() => {
      const host = document.querySelector('.wt-selection-host');
      return !!host && host.parentElement === document.documentElement &&
        !document.body.querySelector('.wt-sel-panel');
    })()`);
  check('selection panel lives outside page DOM', panelIsolated === true);
  await closePage(browserCdp, selectionUrl);
  selectionClient.close();

  /* ============================ 2.0 SSE streaming ============================= */

  // (a) Protocol level: drive the background streaming port directly and
  // assert SSE deltas arrive incrementally with a consistent final text.
  const sseBefore = mock.sseCount();
  const dynText = 'A dynamically inserted paragraph that needs on-demand streaming translation.';
  const sseResult = await ext.eval(`
    new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'wt-stream' });
      const deltas = [];
      const timer = setTimeout(() => resolve({ timeout: true }), 20000);
      port.onMessage.addListener((msg) => {
        if (msg.type === 'delta') deltas.push(msg.delta);
        if (msg.type === 'done') {
          clearTimeout(timer);
          resolve({ deltas, final: msg.text });
          port.disconnect();
        }
        if (msg.type === 'error') {
          clearTimeout(timer);
          resolve({ error: msg.message });
          port.disconnect();
        }
      });
      port.postMessage({ items: [{ key: 'sse-1', text: ${JSON.stringify(dynText)} }], domain: '127.0.0.1' });
    })`, 25000);
  check('SSE endpoint was used', mock.sseCount() === sseBefore + 1, `sse=${mock.sseCount()}`);
  check(
    'streaming delivered multiple incremental deltas',
    Array.isArray(sseResult?.deltas) && sseResult.deltas.length >= 2,
    JSON.stringify(sseResult),
  );
  check(
    'streaming reached final consistent text',
    sseResult?.final === `[译] ${dynText}`,
    JSON.stringify(sseResult?.final),
  );

  // (b) Content level: hover on-demand translate of a dynamically inserted
  // (still idle) paragraph uses the streaming path with typewriter tooltip.
  await page.eval(`location.reload()`);
  await sleep(1200);
  await ext.eval(
    sendToTabWithUrl(pageUrl, `{ type: 'wt:set-mode', mode: 'original_hover_translated' }`),
    5000,
  );
  // Wait for the initial batch translation to finish, then insert a fresh
  // paragraph the observer registers as a new idle entry.
  let initialDone = false;
  for (let i = 0; i < 30; i++) {
    const st = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
    if ((st?.pending ?? 1) === 0 && (st?.translated ?? 0) >= 4) {
      initialDone = true;
      break;
    }
    await sleep(400);
  }
  check('initial batch finished before streaming hover', initialDone);
  await page.eval(`
    (() => {
      const p = document.createElement('p');
      p.id = 'p-dyn';
      p.textContent = ${JSON.stringify(dynText)};
      document.querySelector('article').appendChild(p);
    })()`);
  await sleep(1800); // observer debounce + rescan registers the idle entry
  await page.eval(
    `document.getElementById('p-dyn').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`,
  );
  let tooltipFinal = '';
  for (let i = 0; i < 50; i++) {
    const text = await page.eval(
      `document.querySelector('.wt-tooltip-host')?.shadowRoot?.querySelector('.wt-tooltip')?.textContent ?? ''`,
    );
    if (text === `[译] ${dynText}`) {
      tooltipFinal = text;
      break;
    }
    await sleep(100);
  }
  if (tooltipFinal !== `[译] ${dynText}`) {
    const dbg = await page.eval(`
      (() => {
        const p = document.getElementById('p-dyn');
        const host = document.querySelector('.wt-tooltip-host');
        return {
          hasP: !!p,
          wtId: p?.getAttribute('data-wt-id'),
          bodyText: p?.textContent?.slice(0, 60),
          tooltipHost: !!host,
          tooltipText: host?.shadowRoot?.querySelector('.wt-tooltip')?.textContent?.slice(0, 120) ?? null,
        };
      })()`);
    const dbgState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
    console.log('  DEBUG hover:', JSON.stringify(dbg), JSON.stringify(dbgState));
  }
  check(
    'dynamically inserted paragraph translated on hover (tooltip)',
    tooltipFinal === `[译] ${dynText}`,
    JSON.stringify(tooltipFinal),
  );
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);

  /* ============================ 2.0 bilingual export ========================== */

  // Translate again, then collect the export payload through the background.
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
  const mainTabId = await ext.eval(`
    (async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url ?? '').startsWith(${JSON.stringify(pageUrl)}));
      return tab?.id ?? -1;
    })()`);
  let exportEntries = [];
  for (let i = 0; i < 30; i++) {
    const res = await ext.eval(
      `chrome.runtime.sendMessage({ v: 2, type: 'get-export-payload', tabId: ${mainTabId} })`,
    );
    exportEntries = res?.ok ? res.entries : [];
    if (exportEntries.length >= 4 && exportEntries.every((e) => e.status === 'done')) break;
    await sleep(400);
  }
  check(
    'export payload contains bilingual entries',
    exportEntries.length >= 4 &&
      exportEntries.every((e) => typeof e.original === 'string' && (e.translated ?? '').includes('[译]')),
    `entries=${exportEntries.length}`,
  );
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);
  /* ====================== 2.0 native-host gateway + failover ================= */

  if (gatewayInstalled) {
    // host-status probe through the background.
    const hostStatus = await ext.eval(
      `chrome.runtime.sendMessage({ v: 2, type: 'host-status' })`,
    );
    check(
      'options host-status detects installed gateway',
      hostStatus?.installed === true,
      JSON.stringify(hostStatus),
    );

    // Configure a native-host provider (gateway backend stub-http) as active.
    const nativeSettings = settingsPayload({
      activeProviderId: 'native-gw',
      providers: [
        providerOpenAi('mock', 'Mock LLM', `http://127.0.0.1:${PORT_API}/v1`),
        {
          id: 'native-gw',
          name: 'Local Gateway',
          type: 'native-host',
          baseUrl: '',
          apiKey: '',
          model: '',
          sourceLanguage: 'English',
          targetLanguage: 'Chinese',
          timeoutMs: 20000,
          maxBatchItems: 10,
          maxBatchChars: 6000,
          systemPrompt: '',
          userPromptTemplate: '',
          temperature: 0.2,
          maxTokens: 4096,
          headers: {},
          enabled: true,
          hostName: HOST_NAME,
          backend: 'stub-http',
          fallbackProviderId: 'mock',
        },
      ],
    });
    check('native-host provider saved', await saveSettingsThroughExtension(nativeSettings));

    await page.eval(`location.reload()`);
    await sleep(1200);
    await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
    let gwBlocks = [];
    for (let i = 0; i < 40; i++) {
      gwBlocks = await page.eval(
        `[...document.querySelectorAll('.wt-bilingual-block')].map(b => b.textContent)`,
      );
      if (gwBlocks.length >= 4 && gwBlocks.every((t) => t.includes('[gw]'))) break;
      await sleep(500);
    }
    check(
      'translation served through the real .NET gateway',
      gwBlocks.length >= 4 && gwBlocks.every((t) => t.includes('[gw]')),
      JSON.stringify(gwBlocks),
    );
    const gwState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
    check('gateway translation reports no failures', (gwState?.failed ?? -1) === 0, JSON.stringify(gwState));
    await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);

    // Failover: point the native provider at a host that is NOT installed;
    // the chain must fall back to the mock provider (spec 2.0 §5.6).
    const failoverSettings = settingsPayload({
      activeProviderId: 'native-missing',
      providers: [
        providerOpenAi('mock', 'Mock LLM', `http://127.0.0.1:${PORT_API}/v1`),
        {
          id: 'native-missing',
          name: 'Missing Gateway',
          type: 'native-host',
          baseUrl: '',
          apiKey: '',
          model: '',
          sourceLanguage: 'English',
          targetLanguage: 'Chinese',
          timeoutMs: 15000,
          maxBatchItems: 10,
          maxBatchChars: 6000,
          systemPrompt: '',
          userPromptTemplate: '',
          temperature: 0.2,
          maxTokens: 4096,
          headers: {},
          enabled: true,
          hostName: 'com.example.not-installed',
          backend: '',
          fallbackProviderId: 'mock',
        },
      ],
    });
    check('failover settings saved', await saveSettingsThroughExtension(failoverSettings));
    await page.eval(`location.reload()`);
    await sleep(1200);
    await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
    let foBlocks = [];
    for (let i = 0; i < 40; i++) {
      foBlocks = await page.eval(
        `[...document.querySelectorAll('.wt-bilingual-block')].map(b => b.textContent)`,
      );
      if (foBlocks.length >= 4 && foBlocks.every((t) => t.includes('[译]'))) break;
      await sleep(500);
    }
    check(
      'failover: missing gateway falls back to cloud provider',
      foBlocks.length >= 4 && foBlocks.every((t) => t.includes('[译]')),
      JSON.stringify(foBlocks),
    );
    const logRes = await ext.eval(`chrome.runtime.sendMessage({ type: 'get-error-log' })`);
    const failoverLogged = (logRes?.entries ?? []).some(
      (e) => e.where === 'failover' && e.message.includes('故障转移成功'),
    );
    check('failover recorded in error log', failoverLogged === true, JSON.stringify(logRes?.entries?.[0]));
    const foState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
    check(
      'state exposes actual provider after failover',
      typeof foState?.actualProvider === 'string' && foState.actualProvider.includes('Mock'),
      JSON.stringify(foState?.actualProvider),
    );
    await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);
  } else {
    check('gateway installed for native-host phases', false, 'gateway exe missing or install failed');
  }
} catch (e) {
  failures++;
  console.log(`  FAIL  smoke test crashed — ${e.message}`);
} finally {
  killTree(browser);
  pageServer.close();
  xoriginServer.close();
  mock.server.close();

  // Restore the machine: uninstall the gateway we installed for the test.
  if (gatewayInstalled && !gatewayExistedBefore) {
    try {
      spawnSync(GATEWAY_EXE, ['--uninstall'], { stdio: 'ignore' });
      // The running exe was copied into %LocalAppData%; remove that copy too.
      const installedCopy = path.join(GATEWAY_DIR, 'PolyPage.Gateway.exe');
      for (let i = 0; i < 5 && existsSync(installedCopy); i++) {
        try {
          await rm(installedCopy, { force: true });
        } catch {
          await sleep(600); // host process may still be exiting
        }
      }
    } catch {
      /* best effort */
    }
  }
  await rm(path.dirname(gatewayConfigPath), { recursive: true, force: true }).catch(() => {});
}

console.log(
  failures === 0
    ? `SMOKE TEST: ALL PASSED (${passed} assertions)`
    : `SMOKE TEST: ${failures} FAILURE(S) / ${passed} passed`,
);
process.exit(failures === 0 ? 0 : 1);