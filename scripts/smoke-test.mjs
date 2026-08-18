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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const navPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Nav</title></head>
<body>
  <nav id="sidebar">
    <ul>
      <li id="nav-contents"><a href="#toc">Contents</a></li>
      <li id="nav-about"><a href="#about">About Wikipedia</a></li>
      <li id="nav-tools"><a href="#tools">Tools</a></li>
    </ul>
  </nav>
  <main>
    <p id="nav-prose">The article body paragraph stays long enough for a bilingual block.</p>
  </main>
</body></html>`;

const inlinePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Inline</title></head>
<body>
  <p id="in1">Lead text with <strong>bold markup</strong> and <a href="#">a hyperlink</a> inside the paragraph.</p>
  <p id="in2">A second paragraph that stays plain but long enough for translation.</p>
</body></html>`;

/* --------------------------- 3.0 fixtures: PDF ------------------------------- */

/** Escape PDF string literal specials. */
function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a small multi-page PDF with a real text layer (Helvetica, one Tj per
 * line). Page 4 has an empty content stream => "scanned" page. Xref offsets
 * are computed programmatically so pdf.js accepts the file.
 */
function buildFixturePdf() {
  const HEADER = 'SMOKE CONFERENCE 2026';
  const pages = [
    {
      lines: [
        { t: HEADER, y: 760, size: 9 },
        { t: 'The bilingual reader extracts text layers page by page.', y: 700, size: 12 },
        { t: 'Paragraph clustering rebuilds readable blocks for translation.', y: 680, size: 12 },
        { t: 'A second paragraph starts after a larger vertical gap below.', y: 620, size: 12 },
        { t: '1', y: 40, size: 9 },
      ],
    },
    {
      lines: [
        { t: HEADER, y: 760, size: 9 },
        { t: 'Headers repeating on most pages are filtered before translation.', y: 700, size: 12 },
        { t: '2', y: 40, size: 9 },
      ],
    },
    {
      lines: [
        { t: HEADER, y: 760, size: 9 },
        { t: 'Cache keys carry the document fingerprint for zero-cost reopens.', y: 700, size: 12 },
        { t: '3', y: 40, size: 9 },
      ],
    },
    { lines: [] }, // scanned page placeholder (no text layer)
  ];

  const objects = []; // 1-based; each entry: raw body between "N 0 obj" and "endobj"
  const pageObjIds = [];
  // Reserve ids: 1 catalog, 2 pages tree, 3 font; pages start at 4.
  let nextId = 4;
  const perPage = pages.map((page) => {
    const pageId = nextId++;
    const contentId = nextId++;
    pageObjIds.push(pageId);
    const ops = ['BT'];
    for (const line of page.lines) {
      ops.push(`/F1 ${line.size} Tf`);
      ops.push(`1 0 0 1 50 ${line.y} Tm`);
      ops.push(`(${pdfEscape(line.t)}) Tj`);
    }
    ops.push('ET');
    const stream = ops.join('\n');
    objects[contentId - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    return pageId;
  });
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const fixturePdf = buildFixturePdf();

/* ------------------------ 3.0 fixtures: image & video ------------------------ */

/** 1x1 red PNG, displayed at 320x240 via CSS so the hover button qualifies. */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const imagePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Image</title></head>
<body>
  <p id="img-caption">Hover the picture below and use PolyPage to translate its text.</p>
  <img id="photo" src="/img.png" alt="fixture" style="width:320px;height:240px;background:#ddd;" />
</body></html>`;

const subtitleVtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello from the smoke fixture

2
00:00:04.000 --> 00:00:06.000
Second cue line here
`;

const videoPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Video</title></head>
<body>
  <p id="vid-caption">A fixture video with a WebVTT subtitle track.</p>
  <video id="vid" width="480" height="270" controls preload="metadata" style="background:#000;">
    <track kind="subtitles" src="/subs.vtt" srclang="en" label="English" default />
  </video>
</body></html>`;

function loadCaptionlessWebm() {
  const dir = path.join(root, 'scripts', 'fixtures');
  const out = path.join(dir, 'captionless.webm');
  if (existsSync(out)) {
    const buf = readFileSync(out);
    if (buf.byteLength > 32) return buf;
  }
  mkdirSync(dir, { recursive: true });
  const ffmpeg = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:a', 'libopus', out],
    { stdio: 'ignore' },
  );
  if (ffmpeg.status === 0 && existsSync(out)) return readFileSync(out);
  // Fallback: tiny WebM header. Content script fetch-src fallback still
  // uploads these bytes to the mock /audio/transcriptions endpoint.
  return Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOA', 'base64');
}

const clipWebm = loadCaptionlessWebm();

const captionlessPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Captionless</title></head>
<body>
  <p id="asr-caption">A fixture video with no subtitle track.</p>
  <video id="vid" width="480" height="270" controls preload="auto" src="/clip.webm" style="background:#000;"></video>
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
        '/nav.html': navPage,
        '/image.html': imagePage,
        '/video.html': videoPage,
        '/captionless.html': captionlessPage,
      };
      const pathOnly = url.split('?')[0];
      if (pathOnly === '/sample.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end(fixturePdf);
      }
      if (pathOnly === '/img.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from(PNG_1PX_BASE64, 'base64'));
      }
      if (pathOnly === '/subs.vtt') {
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
        return res.end(subtitleVtt);
      }
      if (pathOnly === '/clip.webm') {
        res.writeHead(200, { 'Content-Type': 'video/webm' });
        return res.end(clipWebm);
      }
      const html = pages[pathOnly];
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
  let visionRequests = 0;
  let asrRequests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if ((req.url ?? '').includes('/audio/transcriptions')) {
        asrRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            text: 'Hello from ASR',
            segments: [{ start: 0, end: 2, text: 'Hello from ASR' }],
          }),
        );
      }
      requests++;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end('{}');
      }

      // 2.0: deliberately slow endpoint for the cancel-on-restore phase.
      if ((req.url ?? '').startsWith('/slow-translate')) {
        const slowTexts = Array.isArray(parsed.q) ? parsed.q : [];
        await sleep(2000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ data: { translations: slowTexts.map((t) => `[slow] ${t}`) } }),
        );
      }

      // 3.0 (pillar F): multimodal vision endpoint — user content is an
      // array containing an image_url part; reply with fixed segments.
      const firstUser = Array.isArray(parsed.messages)
        ? parsed.messages.filter((m) => m.role === 'user').pop()
        : null;
      if (firstUser && Array.isArray(firstUser.content)) {
        const hasImage = firstUser.content.some((p) => p?.type === 'image_url');
        if (hasImage) {
          visionRequests++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '[{"text":"HELLO WORLD","translation":"你好，世界"},' +
                      '{"text":"PolyPage 3.0","translation":"PolyPage 3.0（测试）"}]',
                  },
                },
              ],
            }),
          );
        }
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
      resolve({
        server,
        count: () => requests,
        sseCount: () => sseRequests,
        visionCount: () => visionRequests,
        asrCount: () => asrRequests,
      }),
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

  // 3.0 (spec §9.3): the v2 payload above must land as schema v3 with the
  // pillar E/F/G/H sections defaulted — the real save-settings migration path.
  const savedV3 = await ext.eval(
    `chrome.runtime.sendMessage({ type: 'get-full-settings' }).then((r) => r.settings)`,
  );
  check('v2 payload migrated to schemaVersion 4', savedV3?.schemaVersion === 4, `v=${savedV3?.schemaVersion}`);
  check(
    '3.0 pillar sections defaulted on migration',
    !!savedV3?.pdfViewer &&
      !!savedV3?.imageTranslate &&
      !!savedV3?.subtitles &&
      savedV3?.languageDetection === 'auto' &&
      savedV3?.selectionSpeak === true,
    JSON.stringify({ pdf: !!savedV3?.pdfViewer, img: !!savedV3?.imageTranslate, sub: !!savedV3?.subtitles }),
  );
  check(
    '4.0 sections defaulted on v2→v4 migration',
    savedV3?.asr?.enabled === true &&
      savedV3?.asr?.maxSeconds === 90 &&
      savedV3?.translationMemory?.enabled === false &&
      savedV3?.pdfViewer?.scannedPageOcr === true &&
      savedV3?.subtitles?.swapSrcDst === false,
    JSON.stringify({ asr: savedV3?.asr, tm: savedV3?.translationMemory, scanned: savedV3?.pdfViewer?.scannedPageOcr }),
  );

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

  /* ============================== nav chrome (4.0) ============================== */

  const navUrl = `http://127.0.0.1:${PORT_PAGE}/nav.html`;
  await openPage(browserCdp, navUrl);
  const navPageCdp = await pageFor(navUrl);
  await ext.eval(sendToTabWithUrl(navUrl, `{ type: 'wt:translate' }`), 5000);
  let navSnap = { contents: '', href: '', suffix: '', tools: '', about: '', navBlocks: 0, proseBlocks: 0 };
  for (let i = 0; i < 30; i++) {
    navSnap = await navPageCdp.eval(`(() => {
      const contents = document.querySelector('#nav-contents a');
      const tools = document.querySelector('#nav-tools a');
      const about = document.querySelector('#nav-about a');
      return {
        contents: contents?.textContent ?? '',
        href: contents?.getAttribute('href') ?? '',
        suffix: contents?.querySelector('.wt-nav-translation')?.textContent ?? '',
        tools: tools?.textContent ?? '',
        about: about?.textContent ?? '',
        navBlocks: document.querySelectorAll('nav .wt-bilingual-block').length,
        proseBlocks: document.querySelectorAll('#nav-prose + .wt-bilingual-block, main .wt-bilingual-block').length,
      };
    })()`);
    if (navSnap.suffix.includes('[译]') && navSnap.proseBlocks >= 1) break;
    await sleep(400);
  }
  check('nav keeps the original link href', navSnap.href === '#toc', JSON.stringify(navSnap));
  check(
    'nav Contents gets a compact [译] suffix',
    navSnap.contents.includes('Contents') && navSnap.suffix.includes('[译]'),
    JSON.stringify(navSnap),
  );
  check('short nav label Tools is translated', navSnap.tools.includes('Tools') && navSnap.tools.includes('[译]'), navSnap.tools);
  check('nav About Wikipedia is translated', navSnap.about.includes('About Wikipedia') && navSnap.about.includes('[译]'), navSnap.about);
  check('nav does not use stacked bilingual blocks', navSnap.navBlocks === 0, JSON.stringify(navSnap));
  check('article body next to nav still gets a bilingual block', navSnap.proseBlocks >= 1, JSON.stringify(navSnap));
  await ext.eval(sendToTabWithUrl(navUrl, `{ type: 'wt:restore' }`), 5000);
  await sleep(400);
  const restoredNav = await navPageCdp.eval(`document.querySelector('#nav-contents a')?.textContent ?? ''`);
  check('restore removes nav suffix', restoredNav === 'Contents', JSON.stringify(restoredNav));
  await closePage(browserCdp, navUrl);
  navPageCdp.close();

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
  /* ================ 2.0 cancel on restore (spec §5.3 item 5) ================= */

  const slowSettings = settingsPayload({
    activeProviderId: 'slow',
    providers: [
      {
        id: 'slow',
        name: 'Slow HTTP',
        type: 'custom-http',
        baseUrl: `http://127.0.0.1:${PORT_API}/slow-translate`,
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
        method: 'POST',
        bodyTemplate: '{ "q": {{texts}}, "from": "{{sourceLanguage}}", "to": "{{targetLanguage}}" }',
        responsePath: 'data.translations',
        apiKeyPlacement: 'header',
        apiKeyParamName: 'Authorization',
      },
    ],
  });
  check('slow provider saved', await saveSettingsThroughExtension(slowSettings));
  await page.eval(`location.reload()`);
  await sleep(1200);
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
  await sleep(400); // batch now in flight against the 2s-slow endpoint
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);

  // Watch the whole slow window: no bilingual block may ever appear.
  let maxBlocksDuringSlowWindow = 0;
  const slowDeadline = Date.now() + 3500;
  while (Date.now() < slowDeadline) {
    const n = await page.eval(`document.querySelectorAll('.wt-bilingual-block').length`);
    maxBlocksDuringSlowWindow = Math.max(maxBlocksDuringSlowWindow, n);
    await sleep(150);
  }
  check(
    'restore cancels in-flight translation (no blocks ever rendered)',
    maxBlocksDuringSlowWindow === 0,
    `max=${maxBlocksDuringSlowWindow}`,
  );
  const cancelledState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
  check(
    'cancelled page stays idle with no pending',
    cancelledState?.active === false && (cancelledState?.pending ?? 1) === 0,
    JSON.stringify(cancelledState),
  );
  const bodyAfterCancel = await page.eval(`document.getElementById('p1').textContent`);
  check('original text intact after cancel', bodyAfterCancel === P1, JSON.stringify(bodyAfterCancel));
  check('settings restored', await saveSettingsThroughExtension(settingsPayload({})));

  /* ==================== 3.0 language detection + auto guard ================== */

  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
  let langState = null;
  for (let i = 0; i < 30; i++) {
    langState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
    if ((langState?.pending ?? 1) === 0 && (langState?.translated ?? 0) >= 4) break;
    await sleep(400);
  }
  check(
    'page language auto-detected as en (spec 8.1)',
    langState?.pageLanguage === 'en',
    JSON.stringify(langState?.pageLanguage),
  );
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);

  // Auto-translate guard: target language == page language -> skip + hint.
  const sameLangSettings = settingsPayload({
    autoTranslate: true,
    defaultTargetLanguage: 'English',
  });
  check('same-language guard settings saved', await saveSettingsThroughExtension(sameLangSettings));
  await page.eval(`location.reload()`);
  await sleep(1500);
  const guardState = await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:get-state' }`));
  check(
    'auto-translate skipped when page language == target',
    guardState?.autoSkipped === true && guardState?.active === false,
    JSON.stringify(guardState),
  );
  const guardBlocks = await page.eval(`document.querySelectorAll('.wt-bilingual-block').length`);
  check('no blocks rendered for same-language page', guardBlocks === 0, `blocks=${guardBlocks}`);
  check('settings restored after guard test', await saveSettingsThroughExtension(settingsPayload({})));
  await page.eval(`location.reload()`);
  await sleep(1200);

  /* ============================ 3.0 quality feedback ========================== */

  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
  let fbBlocks = 0;
  for (let i = 0; i < 30; i++) {
    fbBlocks = await page.eval(`document.querySelectorAll('.wt-bilingual-block').length`);
    if (fbBlocks >= 4) break;
    await sleep(400);
  }
  check('bilingual blocks present for feedback test', fbBlocks >= 4, `blocks=${fbBlocks}`);
  // Wait until translations land; the mark button only appears on completed blocks.
  let fbDone = false;
  for (let i = 0; i < 30; i++) {
    fbDone = await page.eval(
      `[...document.querySelectorAll('.wt-bilingual-block')].filter((b) => b.textContent.includes('[译]')).length >= 4`,
    );
    if (fbDone) break;
    await sleep(400);
  }
  check('feedback test blocks fully translated', fbDone === true);
  await page.eval(
    `document.querySelector('.wt-bilingual-block').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 120, clientY: 120 }))`,
  );
  let fbBtnText = null;
  for (let i = 0; i < 15; i++) {
    fbBtnText = await page.eval(`document.querySelector('.wt-feedback-btn')?.textContent ?? null`);
    if (fbBtnText) break;
    await sleep(200);
  }
  check('bad-translation mark button appears on hover', typeof fbBtnText === 'string' && fbBtnText.includes('标记'), JSON.stringify(fbBtnText));
  await page.eval(`document.querySelector('.wt-feedback-btn')?.click()`);
  let fbLog = { entries: [] };
  for (let i = 0; i < 15; i++) {
    fbLog = await ext.eval(`chrome.runtime.sendMessage({ type: 'get-feedback-log' })`);
    if ((fbLog?.entries ?? []).length >= 1) break;
    await sleep(300);
  }
  check(
    'feedback entry recorded with source + translation',
    (fbLog?.entries ?? []).length >= 1 &&
      typeof fbLog.entries[0].source === 'string' &&
      fbLog.entries[0].translation.includes('[译]') &&
      fbLog.entries[0].where === 'page',
    JSON.stringify(fbLog?.entries?.[0]),
  );
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);

  /* ========================== 3.0 Alt+Q repeat-selection ====================== */

  const repeatUrl = `http://127.0.0.1:${PORT_PAGE}/selection.html`;
  await openPage(browserCdp, repeatUrl);
  const repeatClient = await pageFor(repeatUrl);
  await sleep(800);
  await repeatClient.eval(`
    (() => {
      const p = document.getElementById('sel-p');
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 60 }));
    })()`);
  await sleep(400);
  await repeatClient.eval(
    `document.querySelector('.wt-selection-host')?.shadowRoot?.querySelector('.wt-sel-btn')?.click()`,
  );
  let repeatPanel = '';
  for (let i = 0; i < 30; i++) {
    repeatPanel = await repeatClient.eval(
      `document.querySelector('.wt-selection-host')?.shadowRoot?.querySelector('.wt-sel-text')?.textContent ?? ''`,
    );
    if (repeatPanel.includes('[译]')) break;
    await sleep(400);
  }
  check('selection translated before repeat test', repeatPanel.includes('[译]'), JSON.stringify(repeatPanel));
  // Close panel + clear the selection, then replay via the command path.
  await repeatClient.eval(`
    (() => {
      const btns = [...document.querySelector('.wt-selection-host')?.shadowRoot?.querySelectorAll('.wt-sel-actions button') ?? []];
      btns.find((b) => b.textContent === '收起')?.click();
      window.getSelection().removeAllRanges();
    })()`);
  await sleep(300);
  await ext.eval(sendToTabWithUrl(repeatUrl, `{ type: 'wt:repeat-selection' }`), 5000);
  await sleep(400);
  const replayed = await repeatClient.eval(`
    (() => {
      const panel = document.querySelector('.wt-selection-host')?.shadowRoot?.querySelector('.wt-sel-panel');
      return { display: panel?.style.display, text: panel?.querySelector('.wt-sel-text')?.textContent ?? '' };
    })()`);
  check(
    'repeat-selection replays last panel without a selection',
    replayed?.display === 'block' && (replayed?.text ?? '').includes('[译]'),
    JSON.stringify(replayed),
  );
  // Speak button exists (capability probe may disable it in headless).
  const speakBtnPresent = await repeatClient.eval(
    `document.querySelector('.wt-selection-host')?.shadowRoot?.querySelectorAll('.wt-sel-actions button').length >= 4`,
  );
  check('selection panel gained speak + mark buttons', speakBtnPresent === true);
  await closePage(browserCdp, repeatUrl);
  repeatClient.close();

  /* ============================ 3.0 image OCR (pillar F) ===================== */

  // Enable the cache for the OCR + PDF phases (fingerprint/hit assertions).
  check('cache enabled for OCR/PDF phases', await saveSettingsThroughExtension(settingsPayload({ cacheEnabled: true })));

  const imageUrl = `http://127.0.0.1:${PORT_PAGE}/image.html`;
  await openPage(browserCdp, imageUrl);
  const imageClient = await pageFor(imageUrl);
  await sleep(900);
  await imageClient.eval(
    `document.getElementById('photo').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`,
  );
  let hoverBtn = false;
  for (let i = 0; i < 20; i++) {
    hoverBtn = await imageClient.eval(`document.querySelector('.wt-img-btn') !== null`);
    if (hoverBtn) break;
    await sleep(300);
  }
  check('image hover translate button appears (>=200px)', hoverBtn === true);

  const visionBefore = mock.visionCount();
  await imageClient.eval(`document.querySelector('.wt-img-btn')?.click()`);
  let ocrText = '';
  for (let i = 0; i < 40; i++) {
    ocrText = await imageClient.eval(
      `document.querySelector('.wt-ocr-host')?.shadowRoot?.querySelector('.wt-ocr-body')?.textContent ?? ''`,
    );
    if (ocrText.includes('你好，世界')) break;
    await sleep(400);
  }
  check('mock vision endpoint called exactly once', mock.visionCount() === visionBefore + 1, `vision=${mock.visionCount()}`);
  check(
    'OCR result panel lists structured segments',
    ocrText.includes('HELLO WORLD') && ocrText.includes('你好，世界'),
    JSON.stringify(ocrText.slice(0, 120)),
  );
  check(
    'OCR panel isolated in Shadow DOM (never page DOM)',
    (await imageClient.eval(
      `!!document.querySelector('.wt-ocr-host')?.shadowRoot && document.body.querySelector('.wt-ocr-panel') === null`,
    )) === true,
  );

  // Close + re-trigger the same image: cache hit, no second vision call.
  await imageClient.eval(`
    (() => {
      const btns = [...document.querySelector('.wt-ocr-host')?.shadowRoot?.querySelectorAll('button') ?? []];
      btns.find((b) => b.textContent === '收起')?.click();
    })()`);
  await sleep(400);
  await imageClient.eval(
    `document.getElementById('photo').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`,
  );
  await sleep(400);
  await imageClient.eval(`document.querySelector('.wt-img-btn')?.click()`);
  let ocrAgain = '';
  for (let i = 0; i < 40; i++) {
    ocrAgain = await imageClient.eval(
      `document.querySelector('.wt-ocr-host')?.shadowRoot?.querySelector('.wt-ocr-body')?.textContent ?? ''`,
    );
    if (ocrAgain.includes('你好，世界')) break;
    await sleep(400);
  }
  check(
    'second OCR of identical image served from cache',
    mock.visionCount() === visionBefore + 1 && ocrAgain.includes('你好，世界'),
    `vision=${mock.visionCount()}`,
  );

  // Grey-out: provider without vision capability disables the entry.
  const noVisionSettings = settingsPayload({
    cacheEnabled: true,
    activeProviderId: 'no-vision',
    providers: [
      providerOpenAi('mock', 'Mock LLM', `http://127.0.0.1:${PORT_API}/v1`),
      {
        id: 'no-vision',
        name: 'Plain HTTP (no vision)',
        type: 'custom-http',
        baseUrl: `http://127.0.0.1:${PORT_API}/custom-translate`,
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
        method: 'POST',
        bodyTemplate: '{ "q": {{texts}}, "from": "{{sourceLanguage}}", "to": "{{targetLanguage}}" }',
        responsePath: 'data.translations',
        apiKeyPlacement: 'header',
        apiKeyParamName: 'Authorization',
      },
    ],
  });
  check('no-vision provider saved', await saveSettingsThroughExtension(noVisionSettings));
  const csGrey = await ext.eval(`chrome.runtime.sendMessage({ type: 'get-content-settings' })`);
  check('content settings report visionSupported=false', csGrey?.visionSupported === false);
  await imageClient.eval(`location.reload()`);
  await sleep(900);
  await imageClient.eval(
    `document.getElementById('photo').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`,
  );
  let greyTitle = '';
  for (let i = 0; i < 20; i++) {
    greyTitle = await imageClient.eval(`document.querySelector('.wt-img-btn')?.title ?? ''`);
    if (greyTitle) break;
    await sleep(300);
  }
  check('hover entry greyed out with reason', greyTitle.includes('不支持视觉'), JSON.stringify(greyTitle));
  await imageClient.eval(`document.querySelector('.wt-img-btn')?.click()`);
  await sleep(600);
  check(
    'greyed entry never opens the OCR panel',
    (await imageClient.eval(`document.querySelector('.wt-ocr-host') === null`)) === true,
  );
  check('settings restored after grey-out test', await saveSettingsThroughExtension(settingsPayload({ cacheEnabled: true })));
  await closePage(browserCdp, imageUrl);
  imageClient.close();

  /* ========================== 3.0 video subtitles (pillar G) ================= */

  const videoUrl = `http://127.0.0.1:${PORT_PAGE}/video.html`;
  await openPage(browserCdp, videoUrl);
  const videoClient = await pageFor(videoUrl);
  await sleep(1200); // allow the VTT track to load
  await ext.eval(sendToTabWithUrl(videoUrl, `{ type: 'wt:toggle-subtitles' }`), 5000);
  await videoClient.eval(`
    (() => {
      const v = document.getElementById('vid');
      v.currentTime = 1.2;
      v.dispatchEvent(new Event('timeupdate'));
    })()`);
  let cueText = '';
  for (let i = 0; i < 40; i++) {
    cueText = await videoClient.eval(
      `document.querySelector('.wt-subtitle-host')?.shadowRoot?.querySelector('.wt-sub-box')?.textContent ?? ''`,
    );
    if (cueText.includes('[译]') && cueText.includes('Hello from the smoke fixture')) break;
    await sleep(400);
  }
  check(
    'subtitle layer renders bilingual cue (译 + 原文)',
    cueText.includes('[译] Hello from the smoke fixture') && cueText.includes('Hello from the smoke fixture'),
    JSON.stringify(cueText),
  );
  check(
    'original track switched to hidden, not removed',
    (await videoClient.eval(`document.querySelector('track')?.track?.mode`)) === 'hidden',
  );

  // Cue switch: second cue activates and translates.
  await videoClient.eval(`
    (() => {
      const v = document.getElementById('vid');
      v.currentTime = 4.5;
      v.dispatchEvent(new Event('timeupdate'));
    })()`);
  let cue2 = '';
  for (let i = 0; i < 40; i++) {
    cue2 = await videoClient.eval(
      `document.querySelector('.wt-subtitle-host')?.shadowRoot?.querySelector('.wt-sub-box')?.textContent ?? ''`,
    );
    if (cue2.includes('Second cue line here')) break;
    await sleep(400);
  }
  check(
    'cue switch renders the second cue bilingually',
    cue2.includes('Second cue line here') && cue2.includes('[译]'),
    JSON.stringify(cue2),
  );

  // Toggle off: layer removed, track mode restored — zero residue.
  await ext.eval(sendToTabWithUrl(videoUrl, `{ type: 'wt:toggle-subtitles' }`), 5000);
  await sleep(600);
  check(
    'subtitle teardown removes the layer',
    (await videoClient.eval(`document.querySelector('.wt-subtitle-host') === null`)) === true,
  );
  check(
    'track mode restored after teardown',
    (await videoClient.eval(`document.querySelector('track')?.track?.mode`)) === 'showing',
  );
  check(
    'tracked 3.0 video does not auto-ASR',
    mock.asrCount() === 0,
    `asr=${mock.asrCount()}`,
  );
  await closePage(browserCdp, videoUrl);
  videoClient.close();

  /* ========================= 4.0 captionless ASR (pillar I) ================== */

  check(
    'asr smoke settings saved',
    await saveSettingsThroughExtension(
      settingsPayload({
        cacheEnabled: true,
        asr: { enabled: true, maxSeconds: 10, confirmFull: false, maxUploadMb: 20 },
      }),
    ),
  );
  const asrUrl = `http://127.0.0.1:${PORT_PAGE}/captionless.html`;
  await openPage(browserCdp, asrUrl);
  const asrClient = await pageFor(asrUrl);
  await sleep(800);
  const asrBefore = mock.asrCount();
  const asrRes = await ext.eval(sendToTabWithUrl(asrUrl, `{ type: 'wt:transcribe-media' }`), 25000);
  check('captionless wt:transcribe-media returns ok', asrRes?.ok === true, JSON.stringify(asrRes));
  await asrClient.eval(
    `(() => { const v = document.querySelector('video'); if (v) { v.currentTime = 0.25; } })()`,
  );
  let asrCue = '';
  for (let i = 0; i < 40; i++) {
    asrCue = await asrClient.eval(
      `document.querySelector('.wt-subtitle-host')?.shadowRoot?.querySelector('.wt-sub-box')?.textContent ?? ''`,
    );
    if (asrCue.includes('Hello from ASR') || asrCue.includes('[译]')) break;
    await sleep(250);
  }
  check(
    'captionless video mock /audio/transcriptions called exactly once',
    mock.asrCount() === asrBefore + 1,
    `asr=${mock.asrCount()} before=${asrBefore}`,
  );
  check(
    'captionless ASR injects bilingual memory cues',
    asrCue.includes('Hello from ASR') || asrCue.includes('[译]'),
    JSON.stringify(asrCue.slice(0, 160)),
  );
  await ext.eval(sendToTabWithUrl(asrUrl, `{ type: 'wt:transcribe-media' }`), 5000);
  check(
    'ASR close leaves zero residue',
    (await asrClient.eval(`document.querySelector('.wt-subtitle-host') === null`)) === true,
  );
  await closePage(browserCdp, asrUrl);
  asrClient.close();

  /* ========================= 3.0 PDF bilingual reader (E) ==================== */

  const pdfSrc = `http://127.0.0.1:${PORT_PAGE}/sample.pdf`;
  const viewerUrl = `chrome-extension://${extensionId}/viewer/pdf-viewer.html?src=${encodeURIComponent(pdfSrc)}`;
  await openPage(browserCdp, viewerUrl);
  const viewer = await pageFor(viewerUrl);
  // Scroll so lazy pages (incl. the scanned one) enter the observer margin.
  await sleep(800);
  await viewer.eval(`window.scrollTo(0, document.body.scrollHeight)`);
  let pdfDst = [];
  for (let i = 0; i < 60; i++) {
    pdfDst = await viewer.eval(`[...document.querySelectorAll('.para .dst')].map((d) => d.textContent)`);
    if (pdfDst.length >= 4 && pdfDst.filter((t) => t.includes('[译]')).length >= 4) break;
    await sleep(500);
    if (i === 10) await viewer.eval(`window.scrollTo(0, 0)`);
    if (i === 20) await viewer.eval(`window.scrollTo(0, document.body.scrollHeight)`);
  }
  check(
    'PDF reader translates clustered paragraphs via background pipeline',
    pdfDst.filter((t) => t.includes('[译]')).length >= 4,
    JSON.stringify(pdfDst),
  );
  const pdfSrcText = await viewer.eval(
    `[...document.querySelectorAll('.para .src')].map((s) => s.textContent).join(' | ')`,
  );
  check(
    'repeating headers + page numbers filtered out',
    !pdfSrcText.includes('SMOKE CONFERENCE') && pdfSrcText.includes('bilingual reader extracts'),
    JSON.stringify(pdfSrcText.slice(0, 160)),
  );
  const scannedHint = await viewer.eval(`document.querySelector('.scanned-hint')?.textContent ?? ''`);
  check('scanned page shows explicit no-text-layer hint', scannedHint.includes('没有文本层'), JSON.stringify(scannedHint));
  const ocrPageBtn = await viewer.eval(`document.querySelector('.ocr-page-btn')?.textContent ?? ''`);
  check('scanned page offers 识别本页', ocrPageBtn.includes('识别本页'), JSON.stringify(ocrPageBtn));
  const pdfProgress = await viewer.eval(`document.getElementById('progress')?.textContent ?? ''`);
  check('reader toolbar reports translated/total progress', pdfProgress.includes('已译'), JSON.stringify(pdfProgress));
  const canvases = await viewer.eval(`document.querySelectorAll('.page canvas').length`);
  check('reader renders page canvases', canvases >= 1, `canvases=${canvases}`);
  // Drain in-flight PDF batches before snapshotting; otherwise a late
  // first-open completion inflates mock.count() during reopen.
  let drained = mock.count();
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    const n = mock.count();
    if (n === drained) break;
    drained = n;
  }
  await closePage(browserCdp, viewerUrl);
  viewer.close();

  // Reopen: every paragraph must come from the fingerprint cache — zero calls.
  const apiCallsBeforeReopen = mock.count();
  await sleep(400);
  await openPage(browserCdp, viewerUrl);
  const viewer2 = await pageFor(viewerUrl);
  await sleep(800);
  await viewer2.eval(`window.scrollTo(0, document.body.scrollHeight)`);
  let pdfDst2 = [];
  for (let i = 0; i < 60; i++) {
    pdfDst2 = await viewer2.eval(`[...document.querySelectorAll('.para .dst')].map((d) => d.textContent)`);
    if (pdfDst2.filter((t) => t.includes('[译]')).length >= 4) break;
    await sleep(500);
  }
  check('reopened document shows cached translations', pdfDst2.filter((t) => t.includes('[译]')).length >= 4, JSON.stringify(pdfDst2));
  check(
    'reopening costs zero API calls (document fingerprint cache)',
    mock.count() === apiCallsBeforeReopen,
    `before=${apiCallsBeforeReopen} after=${mock.count()}`,
  );
  await closePage(browserCdp, viewerUrl);
  viewer2.close();

  /* ============================ 3.0 resume (pillar H) ======================== */

  // Translate against the 2s-slow endpoint, kill the service worker mid-flight,
  // wake it back up, and assert the persisted task table recovers everything.
  check('slow provider saved for resume test', await saveSettingsThroughExtension(slowSettings));
  await page.eval(`location.reload()`);
  await sleep(1200);
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:translate' }`), 5000);
  await sleep(500); // tasks now recorded in-flight against the slow endpoint

  const targetsBeforeKill = await fetchJson('http://127.0.0.1:9222/json');
  const swTarget = targetsBeforeKill.find(
    (t) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
  );
  check('service worker target located for the kill', !!swTarget);
  if (swTarget) {
    await browserCdp.send('Target.closeTarget', { targetId: swTarget.id });
  }
  await sleep(900);

  // Wake the restarted SW through a runtime message; retry while it boots.
  let swUp = false;
  for (let i = 0; i < 25 && !swUp; i++) {
    try {
      const r = await ext.eval(
        `chrome.runtime.sendMessage({ type: 'get-cache-stats' }).then(() => 'up').catch(() => 'down')`,
        4000,
      );
      swUp = r === 'up';
    } catch {
      swUp = false;
    }
    if (!swUp) await sleep(400);
  }
  check('service worker restarted and reachable', swUp === true);

  let resumeBlocks = [];
  for (let i = 0; i < 50; i++) {
    resumeBlocks = await page.eval(
      `[...document.querySelectorAll('.wt-bilingual-block')].map((b) => b.textContent)`,
    );
    if (resumeBlocks.length >= 4 && resumeBlocks.every((t) => t.includes('[slow]'))) break;
    await sleep(500);
  }
  check(
    'resume: in-flight tasks recovered after SW restart',
    resumeBlocks.length >= 4 && resumeBlocks.every((t) => t.includes('[slow]')),
    JSON.stringify(resumeBlocks),
  );
  await ext.eval(sendToTabWithUrl(pageUrl, `{ type: 'wt:restore' }`), 5000);
  check('settings restored after resume test', await saveSettingsThroughExtension(settingsPayload({})));

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