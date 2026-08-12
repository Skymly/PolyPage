/**
 * Manual integration check (spec 2.0 §12.3 item 1):
 * real local Ollama model translating through the real .NET gateway.
 * Recorded into docs/VALIDATION-2.0.md.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(
  root,
  'native-host/PolyPage.Gateway/bin/Release/net8.0/win-x64/publish/PolyPage.Gateway.exe',
);
const MODEL = process.argv[2] ?? 'qwen3-14b-64k:latest';
const PORT = 8198;

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

const tempDir = await mkdtemp(path.join(tmpdir(), 'polypage-ollama-'));
const configPath = path.join(tempDir, 'gateway.json');
await writeFile(
  configPath,
  JSON.stringify({
    defaultBackend: 'ollama',
    ollama: [
      {
        id: 'ollama',
        name: 'Ollama (local)',
        baseUrl: 'http://localhost:11434',
        model: MODEL,
        apiKey: '',
        timeoutMs: 240000,
      },
    ],
    http: [],
  }),
);

const gateway = spawn(EXE, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, POLYPAGE_GATEWAY_CONFIG: configPath },
});
const decoder = new FrameDecoder();
const pending = new Map();
const deltas = [];
gateway.stdout.on('data', (chunk) => {
  for (const msg of decoder.push(chunk)) {
    if (msg.method === 'translate.delta') {
      deltas.push(msg.params?.delta ?? '');
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  }
});
let seq = 0;
function rpc(method, params, timeoutMs = 300000) {
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
  console.log(`Model: ${MODEL}`);
  const health = await rpc('health', {});
  console.log('health:', JSON.stringify(health.result));

  const started = Date.now();
  const res = await rpc('translate', {
    texts: ['Open source software has changed the world.', 'Please translate this sentence.'],
    source: 'English',
    target: 'Chinese',
    backend: 'ollama',
  });
  const elapsed = Date.now() - started;
  if (res.error) {
    console.log('FAIL translate:', JSON.stringify(res.error));
    process.exitCode = 1;
  } else {
    console.log(`translate ok in ${elapsed}ms:`);
    for (const t of res.result.translations) console.log('  -', t);
  }

  // Streaming single text.
  const started2 = Date.now();
  const stream = await rpc(
    'translate.stream',
    { text: 'Good morning, my friend.', source: 'English', target: 'Chinese', backend: 'ollama' },
  );
  if (stream.error) {
    console.log('FAIL translate.stream:', JSON.stringify(stream.error));
    process.exitCode = 1;
  } else {
    console.log(
      `translate.stream ok in ${Date.now() - started2}ms, ${deltas.length} deltas:`,
      JSON.stringify(stream.result?.translation),
    );
  }
} catch (e) {
  console.log('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  gateway.kill();
  await rm(tempDir, { recursive: true, force: true });
}