/** Isolated Edge fixture for UI tests. Uses the DevTools pipe for loading an
 * unpacked extension and for trusted keyboard, IME and pointer input. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function openFixtureBrowser(extensionDir = 'dist', { headless = true } = {}) {
  const temp = path.resolve(os.tmpdir());
  const profile = await mkdtemp(path.join(temp, 'polypage-browser-'));
  const browser = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    ...(headless ? ['--headless=new'] : []), '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  let ended = false;
  const exited = new Promise(resolve => browser.once('close', resolve));
  function end(error) {
    ended = true;
    for (const finish of pending.values()) finish({ error });
    pending.clear();
  }
  browser.on('error', end);
  browser.once('close', () => end(new Error('Fixture browser exited')));
  browser.stdio[3].on('error', end);
  browser.stdio[4].setEncoding('utf8');
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      pending.get(message.id)?.(message);
    }
  });
  function send(method, params = {}, sessionId) {
    if (ended) return Promise.reject(new Error('Fixture browser is closed'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('DevTools timed out on ' + method));
      }, headless ? 20000 : 45000);
      pending.set(id, message => {
        clearTimeout(timeout);
        pending.delete(id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  async function close() {
    if (!ended) await send('Browser.close').catch(() => browser.kill());
    await exited;
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === temp && path.basename(resolved).startsWith('polypage-browser-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }
  try {
    const extensionId = extensionDir === null ? null :
      (await send('Extensions.loadUnpacked', { path: path.resolve(extensionDir) })).id;
    async function attach(targetId) {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      return {
        targetId, send: (method, params) => send(method, params, sessionId),
        async eval(expression) {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          return r.result.value;
        },
      };
    }
    return {
      extensionId, send, close, attach,
      async page(url) {
        const { targetId } = await send('Target.createTarget', { url });
        return attach(targetId);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
