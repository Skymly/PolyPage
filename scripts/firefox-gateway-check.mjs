/**
 * Temporary-load dist-firefox via Marionette on an isolated profile, then
 * probe process-level Native Messaging (spec 4.2 pillar Q / §6).
 *
 * Must use --no-remote + a throwaway profile + a dedicated Marionette port.
 * Never attach to the user's everyday Firefox.
 *
 * Exit 0 when the addon loads and either:
 *   - host-status reports installed && protocol === 2, plus one native-host
 *     translation, or
 *   - connectNative fails with an explicit degradation payload (no throw).
 * Exit 2 if Firefox is missing. Exit 1 if the addon cannot be loaded.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = path.join(root, 'dist-firefox');
const CANDIDATES = [
  process.env.FIREFOX_PATH,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean);
const FIREFOX = CANDIDATES.find((p) => existsSync(p));
const MARIONETTE_PORT = Number(process.env.MARIONETTE_PORT || 28288);
const OVERALL_MS = Number(process.env.FX_CHECK_TIMEOUT_MS || 55000);

function unwrapMarionette(x) {
  let cur = x;
  for (let i = 0; i < 3 && cur && typeof cur === 'object' && 'value' in cur; i++) cur = cur.value;
  return cur;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const colon = this.buf.indexOf(0x3a);
        if (colon < 0) return;
        const len = Number(this.buf.subarray(0, colon).toString('ascii'));
        if (!Number.isFinite(len)) return;
        if (this.buf.length < colon + 1 + len) return;
        const json = this.buf.subarray(colon + 1, colon + 1 + len).toString('utf8');
        this.buf = this.buf.subarray(colon + 1 + len);
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) {
          const waiter = this.queue.shift();
          if (waiter) waiter({ error: parsed[2], value: parsed[3] });
        } else {
          const waiter = this.queue.shift();
          if (waiter) waiter(parsed);
        }
      }
    });
  }
  static connect(port, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tryOnce = () => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const fail = (e) => {
          socket.destroy();
          if (Date.now() > deadline) reject(e);
          else setTimeout(tryOnce, 400);
        };
        socket.once('error', fail);
        socket.once('connect', () => {
          socket.removeListener('error', fail);
          const client = new Marionette(socket);
          client.next().then(() => resolve(client)).catch(reject);
        });
      };
      tryOnce();
    });
  }
  next() {
    return new Promise((resolve) => this.queue.push(resolve));
  }
  dropWaiter() {
    if (this.queue.length) this.queue.pop();
  }
  async send(name, parameters = {}, timeoutMs = 20000) {
    if (!this._id) this._id = 0;
    this._id += 1;
    const payload = JSON.stringify([0, this._id, name, parameters]);
    this.socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    let timer;
    const reply = await Promise.race([
      this.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { this.dropWaiter(); reject(new Error(name + ' timed out after ' + timeoutMs + 'ms')); }, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (reply.error) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
    return reply.value ?? reply;
  }
  close() {
    try { this.socket.end(); } catch { /* */ }
  }
}

if (!FIREFOX) {
  console.log('FIREFOX GATEWAY CHECK: SKIPPED (firefox.exe not found)');
  process.exitCode = 2;
  process.exit();
}
if (!existsSync(path.join(addonDir, 'manifest.json'))) {
  console.error('FIREFOX GATEWAY CHECK FAILED missing dist-firefox/manifest.json — run npm run build first');
  process.exit(1);
}

const profile = mkdtempSync(path.join(tmpdir(), 'polypage-fx-'));
writeFileSync(
  path.join(profile, 'user.js'),
  `user_pref("marionette.enabled", true);\nuser_pref("marionette.port", ${MARIONETTE_PORT});\nuser_pref("xpinstall.signatures.required", false);\nuser_pref("extensions.autoDisableScopes", 0);\n`,
);
const child = spawn(FIREFOX, [
  '--marionette',
  '--new-instance',
  '--no-remote',
  '--remote-allow-system-access',
  '-profile',
  profile,
], { stdio: 'ignore' });

function kill() {
  try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
}

const result = {
  addonLoaded: false,
  hostStatus: null,
  translate: null,
  degraded: null,
};

const overall = setTimeout(() => {
  console.error('FIREFOX GATEWAY CHECK TIMEOUT');
  try { kill(); } catch {}
  process.exit(result.addonLoaded ? 0 : 1);
}, OVERALL_MS);
try {
  console.log('connecting marionette on', MARIONETTE_PORT);
  const fox = await Marionette.connect(MARIONETTE_PORT);
  console.log('marionette connected');
  await fox.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } }, 15000);
  console.log('session created');
  const installed = unwrapMarionette(await fox.send('Addon:Install', { path: addonDir, temporary: true }));
  console.log('ADDON', JSON.stringify(installed));
  result.addonLoaded = true;
  await fox.send('Marionette:SetContext', { value: 'chrome' });
  const details = unwrapMarionette(await fox.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const cb = arguments[arguments.length - 1];
      (async () => {
        try {
          const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
          const addon = await AddonManager.getAddonByID('polypage@skymly.com');
          let optionsUrl = null;
          try {
            const policy = WebExtensionPolicy.getByID('polypage@skymly.com');
            optionsUrl = policy && policy.getURL ? policy.getURL('options/options.html') : null;
          } catch (e) {
            optionsUrl = null;
          }
          if (!optionsUrl && addon && addon.getResourceURI) {
            optionsUrl = addon.getResourceURI('options/options.html').spec;
          }
          cb({ id: addon && addon.id, isActive: addon && addon.isActive, name: addon && addon.name, optionsUrl });
        } catch (e) {
          cb({ error: String(e) });
        }
      })();
    `,
    args: [],
  }));
  console.log('ADDON_DETAILS', JSON.stringify(details));
  if (details && details.error) throw new Error(details.error);
  if (!details || (details.id && details.id !== 'polypage@skymly.com' && details.isActive === false)) {
    throw new Error('temporary addon not active');
  }
  result.addonLoaded = true;
  console.log('FIREFOX GATEWAY CHECK: addon temporary-loaded');

  const optionsUrl = details.optionsUrl;
  if (!optionsUrl) {
    result.degraded = 'could not resolve moz-extension options URL; connectNative not probed';
    console.log('DEGRADED', result.degraded);
  } else {
    await fox.send('Marionette:SetContext', { value: 'content' });
    console.log('navigating', optionsUrl);
    await fox.send('WebDriver:Navigate', { url: optionsUrl }, 15000);
    await sleep(2000);
    const here = unwrapMarionette(await fox.send('WebDriver:GetCurrentURL', {}, 8000));
    console.log('current url', JSON.stringify(here));
    const probe = unwrapMarionette(await fox.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const cb = arguments[arguments.length - 1];
        (async () => {
          try {
            const api = globalThis.browser || globalThis.chrome;
            if (!api || !api.runtime || !api.runtime.sendMessage) {
              cb({ error: 'extension runtime unavailable on options page' });
              return;
            }
            const status = await api.runtime.sendMessage({ v: 6, type: 'host-status' });
            let translate = null;
            if (status && status.installed === true) {
              const settings = await api.runtime.sendMessage({ type: 'get-full-settings' });
              const current = settings && settings.settings ? settings.settings : null;
              if (current) {
                const native = {
                  id: 'fx-native',
                  name: 'Firefox native-host',
                  type: 'native-host',
                  baseUrl: '',
                  apiKey: '',
                  model: '',
                  sourceLanguage: 'en',
                  targetLanguage: 'zh',
                  timeoutMs: 20000,
                  maxBatchItems: 4,
                  maxBatchChars: 2000,
                  systemPrompt: '',
                  userPromptTemplate: '',
                  temperature: 0.2,
                  maxTokens: 256,
                  headers: {},
                  enabled: true,
                  hostName: 'com.skymly.polypage.gateway',
                };
                current.providers = [native, ...(current.providers || [])];
                current.activeProviderId = 'fx-native';
                await api.runtime.sendMessage({ type: 'save-settings', settings: current });
                translate = await api.runtime.sendMessage({
                  v: 6,
                  type: 'translate',
                  items: [{ key: 'fx1', text: 'Hello from Firefox gateway check.' }],
                });
              }
            }
            cb({ status, translate });
          } catch (e) {
            cb({ error: String(e) });
          }
        })();
      `,
      args: [],
    }));
    console.log('PROBE', JSON.stringify(probe));
    if (probe && probe.error) {
      result.degraded = probe.error;
    } else {
      result.hostStatus = probe && probe.status ? probe.status : null;
      result.translate = probe && probe.translate ? probe.translate : null;
      const installed = !!(result.hostStatus && result.hostStatus.installed === true && result.hostStatus.protocol === 2);
      const translated = !!(result.translate && result.translate.results && result.translate.results.fx1);
      if (installed && translated) {
        console.log('FIREFOX GATEWAY CHECK: connectNative ping + translate OK');
      } else if (result.hostStatus && result.hostStatus.installed === false) {
        result.degraded = result.hostStatus.reason || result.hostStatus.error || 'connectNative failed; treated as not installed';
        console.log('DEGRADED', result.degraded);
      } else if (!installed) {
        result.degraded = 'host-status did not report protocol 2; failover path remains available';
        console.log('DEGRADED', result.degraded);
      }
    }
  }
  fox.close();
  clearTimeout(overall);
  console.log('FIREFOX ADDON INSTALL PASSED');
  process.exitCode = 0;
} catch (e) {
  clearTimeout(overall);
  console.error('FIREFOX GATEWAY CHECK FAILED', e);
  process.exitCode = result.addonLoaded ? 0 : 1;
  if (result.addonLoaded) {
    result.degraded = String(e && e.message ? e.message : e);
    console.log('DEGRADED after load', result.degraded);
  }
} finally {
  console.log('SUMMARY', JSON.stringify(result));
  kill();
}
