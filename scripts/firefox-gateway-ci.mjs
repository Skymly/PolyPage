import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePublishedGateway } from './ensure-gateway-publish.mjs';
import { GECKO_ID } from './manifest-firefox.mjs';

if (process.platform !== 'win32' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Use a disposable GitHub-hosted Windows runner for the Firefox registration check.');
}

const exe = ensurePublishedGateway();
const dir = await mkdtemp(path.join(tmpdir(), 'polypage-fx-gateway-'));
const configPath = path.join(dir, 'gateway.json');
const hostName = `com.skymly.polypage.gateway.firefox_${randomUUID().replaceAll('-', '')}`;
const input = 'Hello from Firefox gateway check.';
const translation = 'Firefox gateway CI fixture translation.';
const env = {
  ...process.env,
  POLYPAGE_GATEWAY_CONFIG: configPath,
  MOZ_HEADLESS: '1',
  FX_CHECK_TIMEOUT_MS: '120000',
  FX_GATEWAY_HOST_NAME: hostName,
  FX_GATEWAY_EXPECTED_TRANSLATION: translation,
};

function gateway(...args) {
  const result = spawnSync(exe, ['--host-name', hostName, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Gateway ${args[0]} exited ${result.status ?? result.signal}`);
}

const stub = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { q } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.method !== 'POST' || req.url !== '/translate' || !Array.isArray(q) || q.length !== 1 || q[0] !== input) {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { translations: [translation] } }));
  } catch {
    res.writeHead(400).end();
  }
});

let installAttempted = false;
try {
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  await writeFile(configPath, JSON.stringify({
    defaultBackend: 'fixture',
    http: [{
      id: 'fixture',
      url: `http://127.0.0.1:${stub.address().port}/translate`,
      method: 'POST',
      bodyTemplate: '{ "q": {{texts}} }',
      responsePath: 'data.translations',
      timeoutMs: 5000,
    }],
  }));
  installAttempted = true;
  gateway('--install', '--allow-id', GECKO_ID);
  const check = fileURLToPath(new URL('./firefox-gateway-check.mjs', import.meta.url));
  const child = spawn(process.execPath, [check], { env, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Firefox gateway check exited ${code ?? signal}`);
} finally {
  try {
    if (installAttempted) gateway('--uninstall');
  } finally {
    stub.close();
    await rm(dir, { recursive: true, force: true });
  }
}
