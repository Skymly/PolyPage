/** Test the public YouTube iframe in Edge with its own caption tracks.
 * Set PLAYWRIGHT_MODULE to a local Playwright package if it is not on NODE_PATH. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { normal, translation, validateSrt, waitFor, inPage, currentCues } from './youtube-subtitles-check.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const hostUrl = 'https://ableplayer.github.io/ableplayer/demos/youtube3.html';
const iframeUrl = 'https://www.youtube-nocookie.com/embed/EcFzdNEkqok';
const args = process.argv.slice(2);
const argument = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const sources = new Set();
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/translate') return response.writeHead(404).end();
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { q } = JSON.parse(Buffer.concat(chunks));
    assert.ok(Array.isArray(q) && q.every(text => typeof text === 'string'));
    for (const text of q) sources.add(normal(text));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ translations: q.map(translation) }));
  } catch { response.writeHead(400).end(); }
});

const temp = await mkdtemp(path.join(os.tmpdir(), 'polypage-embed-'));
let context, iframe;
let phase = 'launch';
const captionResponses = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: !args.includes('--headed'), locale: 'en-US', viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--remote-debugging-port=0'],
    downloadsPath: temp, acceptDownloads: true,
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const downloads = path.join(temp, 'downloads');
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve(argument('--extension') || 'dist') });
  const base = 'chrome-extension://' + id;
  const settings = await context.newPage();
  await settings.goto(base + '/options/options.html');
  const provider = {
    id: 'embed-test', type: 'custom-http', name: 'Local caption test', enabled: true,
    sourceLanguage: 'auto', targetLanguage: '简体中文', method: 'POST',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/translate',
    bodyTemplate: '{"q":{{texts}}}', responsePath: 'translations',
  };
  const conf = { autoTranslate: false, cacheEnabled: false, translationMemory: { enabled: false },
    activeProviderId: provider.id, providers: [provider] };
  assert.ok((await settings.evaluate(settings => chrome.runtime.sendMessage({ type: 'save-settings', settings }), conf)).ok);
  const host = await context.newPage();
  host.on('response', async response => {
    const url = new URL(response.url());
    if (url.hostname !== 'www.youtube-nocookie.com' || url.pathname !== '/api/timedtext') return;
    try {
      captionResponses.push({ status: response.status(), bytes: (await response.body()).byteLength });
    } catch { /* Pending or closed response. */ }
  });
  await host.goto(hostUrl, { waitUntil: 'domcontentloaded' });
  const frameStates = () => settings.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === url);
    const { frames } = await chrome.runtime.sendMessage({ type: 'get-frame-states', tabId: tab.id });
    return frames.map(f => ({ frameId: f.frameId, subtitles: f.state.subtitles, subtitleVideos: f.state.subtitleVideos }));
  }, hostUrl);

  async function openPopup() {
    await host.bringToFront();
    const id = await settings.evaluate(async url => {
      // Opening the action popup via CDP preserves the same active-tab lookup as clicking the icon.
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (tab?.url !== url) throw Error('The video tab is not active');
      await chrome.action.openPopup();
      return tab.id;
    }, hostUrl);
    assert.ok(id);
    const { targetId } = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(
      target => target.url === base + '/popup/popup.html'));
    const [port, endpoint] = (await readFile(path.join(temp, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    const socket = new WebSocket('ws://127.0.0.1:' + port + endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let seq = 0;
    function send(method, params, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          socket.removeEventListener('message', receive);
          reject(Error('Popup DevTools timed out on ' + method));
        }, 10000);
        function receive(event) {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener('message', receive);
          if (message.error) reject(Error(message.error.message));
          else resolve(message.result);
        }
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    return {
      async eval(expression) {
        const response = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
        assert.ok(!response.exceptionDetails, 'Popup action failed');
        return response.result.value;
      },
      async close() {
        await send('Target.closeTarget', { targetId }).catch(() => undefined);
        socket.close();
      },
    };
  }
  async function language(name) {
    const control = host.locator('.able-button-handler-captions');
    const option = host.locator('[role=menuitemradio]:visible').filter({ hasText: new RegExp('^' + name + '$') });
    if (!(await option.isVisible())) await control.click({ timeout: 15000 });
    await option.click({ timeout: 5500 });
  }
  async function seek(fraction) {
    const slider = host.getByRole('slider', { name: 'video timeline' });
    const track = slider.locator('..');
    const box = await track.boundingBox();
    assert.ok(box && box.width > 100, 'Host playback timeline is unavailable');
    await track.click({ position: { x: Math.round(box.width * fraction), y: Math.round(box.height * 0.5) } });
  }
  phase = 'play';
  await host.locator('.able-button-handler-play').click({ timeout: 45000 });
  iframe = await waitFor(() => host.frames().find(frame => frame.url().startsWith(iframeUrl)), 30000);
  const mediaTime = () => iframe.evaluate(() => document.querySelector('video')?.currentTime || 0);
  await waitFor(async () => (await mediaTime()) > 0.5, 21000);
  await language('English');
  phase = 'English caption';
  const cues = () => iframe.evaluate(inPage(currentCues));
  const firstCue = (pattern, translated = false, timeout = 25000) => waitFor(async () => (await cues()).find(row =>
    pattern.test(row.source) && (!translated || (sources.has(normal(row.source)) && row.dst === translation(row.source)))), timeout);
  const englishPattern = /music|my name|born|school|disabilities/i;
  const spanishPattern = /música|llamo|nací|escuela|discapacidades/i;
  // The first spoken English cue starts at 48 seconds. Recover from a missed music cue.
  const english = await firstCue(englishPattern, false, 8500).catch(async () => {
    await seek(0.276);
    return firstCue(englishPattern);
  });

  phase = 'popup';
  let popup = await openPopup();
  await waitFor(() => popup.eval('document.querySelector("#info-progress")?.textContent.includes("个段落")'));
  const popupVisible = await popup.eval('!!document.querySelector("#btn-toggle-subtitles")?.offsetWidth');
  console.log(JSON.stringify({ english: english.source, frameStates: await frameStates(), popupVisible }));
  await popup.close();
  if (args.includes('--inspect')) {
    await language('Spanish');
    const spanish = await firstCue(spanishPattern);
    console.log(JSON.stringify({ spanish: spanish.source, frameStates: await frameStates(), submittedSourceCount: sources.size }));
  } else {
    assert.ok(popupVisible, 'popup subtitle toggle is hidden');
    phase = 'English translation';
    const translatedEn = english.dst === translation(english.source) ? english :
      await firstCue(englishPattern, true, 3500).catch(async () => {
        await seek(0.247);
        return firstCue(englishPattern, true);
      });
    await language('Spanish');
    phase = 'Spanish translation';
    const translatedEs = await firstCue(spanishPattern, true, 9000).catch(async () => {
      await seek(0.247);
      return firstCue(spanishPattern, true);
    });
    phase = 'seek';
    const before = await mediaTime();
    await seek(0.34);
    const after = await waitFor(async () => { const time = await mediaTime(); return time > 62 && time < 85 && time; });
    const speech = /do-it|tutores|estudiantes|discapacidad|bienvenida|hablando/i;
    const afterSeek = await firstCue(speech, true);
    assert.notEqual(afterSeek.source, translatedEs.source);
    console.log(JSON.stringify({ seekFrom: before, seekTo: after }));

    await sleep(300);
    phase = 'pause on source cue';
    await host.locator('.able-button-handler-play').click();
    await waitFor(() => iframe.evaluate(() => document.querySelector('video').paused));
    phase = 'enter fullscreen';
    const fullscreen = host.locator('.able-button-handler-fullscreen');
    const playerIsFullscreen = () => host.evaluate(() => !!document.fullscreenElement?.querySelector('iframe'));
    await fullscreen.click();
    await waitFor(playerIsFullscreen, 2500).catch(async () => {
      await fullscreen.press('Enter');
      return waitFor(playerIsFullscreen);
    });
    phase = 'spoken cue in fullscreen';
    const full = await firstCue(speech, true);
    phase = 'exit fullscreen';
    await fullscreen.click();
    await waitFor(() => host.evaluate(() => !document.fullscreenElement));
    const sourceBeforeClose = (await cues()).map(cue => cue.source).filter(source => speech.test(source));
    assert.ok(sourceBeforeClose.length);

    phase = 'SRT export';
    popup = await openPopup();
    await waitFor(() => popup.eval('!!document.querySelector("#btn-export-srt")?.offsetWidth'));
    await popup.eval('document.querySelector("#btn-export-srt").click()');
    const name = await waitFor(async () => (await readdir(downloads).catch(() => [])).find(file => file.endsWith('.srt')));
    const bytes = await readFile(path.join(downloads, name));
    const count = validateSrt(bytes, sources, full.dst);
    assert.doesNotMatch(bytes.toString('utf8'), /\r\n(?:Spanish|Click for settings)\r\n/);
    if (argument('--keep-srt')) await writeFile(argument('--keep-srt'), bytes, { flag: 'wx' });

    phase = 'restore';
    await popup.eval('document.querySelector("#btn-toggle-subtitles").click()');
    await popup.close();
    await waitFor(async () => {
      const current = await cues();
      return sourceBeforeClose.every(source => current.some(cue => cue.source === source && !cue.dst)) &&
        !await iframe.evaluate(() => !!document.querySelector('[data-wt-caption-translation]'));
    });
    console.log(JSON.stringify({ passed: true, english: translatedEn.source, spanish: translatedEs.source,
      postSeek: afterSeek.source, fullScreenSource: full.source, restored: true, srtCues: count,
      bytes: bytes.length, submittedSourceCount: sources.size, frameStates: await frameStates() }));
  }
} catch (error) {
  const state = await iframe?.evaluate(() => {
    const video = document.querySelector('video');
    return { mediaTime: video?.currentTime, ready: video?.readyState, paused: video?.paused,
      visibleSegments: Array.from(document.querySelectorAll('.ytp-caption-segment')).filter(el => el.getClientRects().length).length };
  }).catch(() => null);
  console.error('Failed at', phase, error.message.split('\n')[0], state ?? {}, captionResponses);
  process.exitCode = 1;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
