/**
 * Gateway contract test (spec 2.0 §12.3):
 * launches the REAL published .NET gateway as a child process and talks to
 * it over genuine Native Messaging stdio frames (32-bit LE length prefix +
 * JSON-RPC 2.0), with an HttpBackend pointing at a local stub API.
 *
 * Usage: node scripts/gateway-contract-test.mjs [path-to-exe]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE =
  process.argv[2] ??
  path.join(
    root,
    'native-host/PolyPage.Gateway/bin/Release/net8.0/win-x64/publish/PolyPage.Gateway.exe',
  );

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------------ frame helpers -------------------------------- */

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      out.push(JSON.parse(payload.toString('utf8')));
    }
    return out;
  }
}

/* ------------------------------- stub backend -------------------------------- */

const PORT = 8199;
let stubCalls = 0;
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    stubCalls++;
    let texts = [];
    try {
      texts = JSON.parse(body).q ?? [];
    } catch {
      /* keep empty */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: { translations: texts.map((t) => `[gw] ${t}`) },
      }),
    );
  });
});
await new Promise((resolve) => stub.listen(PORT, '127.0.0.1', resolve));

/* ----------------------------- gateway process ------------------------------- */

const tempDir = await mkdtemp(path.join(tmpdir(), 'polypage-gw-'));
const configPath = path.join(tempDir, 'gateway.json');
await writeFile(
  configPath,
  JSON.stringify({
    defaultBackend: 'stub-http',
    ollama: [],
    http: [
      {
        id: 'stub-http',
        name: 'Stub HTTP backend',
        url: `http://127.0.0.1:${PORT}/translate`,
        method: 'POST',
        bodyTemplate: '{ "q": {{texts}}, "from": "{{sourceLanguage}}", "to": "{{targetLanguage}}" }',
        responsePath: 'data.translations',
        apiKey: '',
        headers: {},
        timeoutMs: 5000,
      },
    ],
  }),
);

const gateway = spawn(EXE, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, POLYPAGE_GATEWAY_CONFIG: configPath },
});

const decoder = new FrameDecoder();
const pending = new Map();
const notifications = [];
gateway.stdout.on('data', (chunk) => {
  for (const msg of decoder.push(chunk)) {
    if (msg.method) {
      notifications.push(msg);
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  }
});
let stderrTail = '';
gateway.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk.toString()).slice(-2000);
});

let seq = 0;
function rpc(method, params, timeoutMs = 15000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    gateway.stdin.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
  });
}

try {
  // 1. ping
  const ping = await rpc('ping', {});
  check('ping returns protocol version', ping.result?.protocol === 1, JSON.stringify(ping));
  check('ping reports gateway version', typeof ping.result?.version === 'string', JSON.stringify(ping));

  // 2. capabilities
  const caps = await rpc('capabilities', {});
  check(
    'capabilities lists stub backend',
    Array.isArray(caps.result?.backends) && caps.result.backends.includes('stub-http'),
    JSON.stringify(caps.result),
  );

  // 3. translate via HttpBackend -> stub API
  const translate = await rpc('translate', {
    texts: ['Hello gateway', 'Second text'],
    source: 'English',
    target: 'Chinese',
    backend: 'stub-http',
  });
  check(
    'translate routes through backend',
    JSON.stringify(translate.result?.translations) === JSON.stringify(['[gw] Hello gateway', '[gw] Second text']),
    JSON.stringify(translate),
  );
  check('stub API received the request', stubCalls === 1, `calls=${stubCalls}`);

  // 4. backends.list + health
  const list = await rpc('backends.list', {});
  check('backends.list returns metadata', list.result?.backends?.[0]?.id === 'stub-http', JSON.stringify(list.result));
  const health = await rpc('health', {});
  check('health reports backend configured', health.result?.backends?.[0]?.ok === true, JSON.stringify(health.result));

  // 5. batch limit error (config error asking extension to pre-split)
  const big = await rpc('translate', {
    texts: Array.from({ length: 60 }, (_, i) => `t${i}`),
    source: 'en',
    target: 'zh',
    backend: 'stub-http',
  });
  check('oversized batch rejected with config error', big.error?.code === -32007, JSON.stringify(big.error));

  // 6. unknown method
  const unknown = await rpc('no.such', {});
  check('unknown method -> -32601', unknown.error?.code === -32601, JSON.stringify(unknown.error));
} catch (e) {
  failures++;
  console.log(`  FAIL  contract test crashed — ${e.message}`);
  if (stderrTail) console.log(stderrTail);
} finally {
  gateway.kill();
  stub.close();
  await rm(tempDir, { recursive: true, force: true });
}

console.log(failures === 0 ? 'GATEWAY CONTRACT: ALL PASSED' : `GATEWAY CONTRACT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);