/** Generate the input with scripts/fixtures/make-reader-sample.py. Compare
 * builds with: node scripts/pdf-reader-check.mjs sample.pdf [extension-dir] [--baseline].
 * Each run starts an empty profile. Only the text Provider is simulated. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { openFixtureBrowser } from './chromium-fixture.mjs';

if (!process.argv[2]) throw Error('Expected the path of the generated PDF sample.');
const pdfPath = path.resolve(process.argv[2]);
const bytes = await readFile(pdfPath);
const downloads = await mkdtemp(path.join(tmpdir(), 'polypage-pdf-downloads-'));
let requests = 0;
let serviceGate;
const contexts = new Map();
const server = createServer(async (req, res) => {
  if (req.url === '/reading.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(bytes);
    return;
  }
  if (req.method !== 'POST' || req.url !== '/translate') { res.writeHead(404).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  requests++;
  await serviceGate;
  await sleep(60);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const { q, title, section } = JSON.parse(body);
  for (const text of q) contexts.set(text, { title, section });
  res.end(JSON.stringify({ out: q.map((s) => '【译文】' + s) }));
});

async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(30);
  } while (Date.now() < deadline);
  throw Error('Timed out: ' + description);
}

// Watch actual canvas pixels on animation frames, including transparent/empty canvas checks.
function measureFrames() {
  window.pdfMeasurements = {};
  function measure() {
    const marks = window.pdfMeasurements;
    const page = document.querySelector('.page[data-page="1"]');
    const cv = page?.querySelector('canvas');
    if (!marks.canvas && cv?.width > 300 && cv.height > 0) {
      const bounds = cv.getBoundingClientRect();
      const top = Math.floor(cv.height * 0.05);
      const pixels = cv.getContext('2d').getImageData(0, top, cv.width, Math.floor(cv.height * 0.2)).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 200 && pixels[i] < 120) {
          const visibleY = bounds.top + (top + Math.floor(i / 4 / cv.width)) * bounds.height / cv.height;
          if (visibleY < 0 || visibleY > innerHeight) continue;
          marks.canvas = Math.round(performance.now());
          marks.pageNodes = document.querySelectorAll('.page').length;
          break;
        }
      }
    }
    if (page?.querySelector('.dst')?.textContent.includes('【译文】')) marks.translated ??= Math.round(performance.now());
    if (!marks.canvas || !marks.translated) requestAnimationFrame(measure);
  }
  requestAnimationFrame(measure);
}

let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await openFixtureBrowser(process.argv[3] || 'dist');
  const base = 'chrome-extension://' + browser.extensionId;
  const config = await browser.page(base + '/options/options.html');
  await until(() => config.eval('!!chrome.runtime?.id'), 'options initialization');
  const settings = {
    schemaVersion: 2, activeProviderId: 'reader-check', defaultTargetLanguage: '简体中文', cacheEnabled: true,
    imageTranslate: { engine: 'tesseract-wasm', enabled: true }, providers: [{
      id: 'reader-check', name: 'PDF check', type: 'custom-http', baseUrl: origin + '/translate', enabled: true,
      sourceLanguage: 'auto', targetLanguage: '简体中文', maxBatchItems: 10, maxBatchChars: 6000,
      timeoutMs: 10000, method: 'POST', bodyTemplate: '{"q":{{texts}},"title":"{{documentTitle}}","section":"{{section}}"}', responsePath: 'out',
    }],
  };
  const saved = await config.eval('chrome.runtime.sendMessage({type:"save-settings", settings:' + JSON.stringify(settings) + '})');
  assert.equal(saved.ok, true);
  console.log((await browser.send('Browser.getVersion')).product, bytes.length, createHash('sha256').update(bytes).digest('hex'));

  for (const condition of ['cold', 'warm']) {
    const page = await browser.page('about:blank');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + measureFrames.toString() + ')()' });
    const startCalls = requests;
    await page.send('Page.navigate', { url: base + '/viewer/pdf-viewer.html?src=' + encodeURIComponent(origin + '/reading.pdf') });
    const marks = await until(() => page.eval('window.pdfMeasurements?.canvas && window.pdfMeasurements?.translated ? window.pdfMeasurements : null'), 'first translated paragraph');
    await sleep(450);
    console.log(condition, { ...marks, requests: requests - startCalls });
    if (condition === 'warm') assert.equal(requests, startCalls);
    if (!process.argv.includes('--baseline')) assert.equal(marks.pageNodes, 1);
    await browser.send('Target.closeTarget', { targetId: page.targetId });
  }

  if (!process.argv.includes('--baseline')) {
    const popup = await browser.page(base + '/popup/popup.html');
    const href = await until(() => popup.eval('document.querySelector("#open-local-pdf")?.href'), 'popup file entry');
    const page = await browser.page(href);
    await until(() => page.eval('!!document.querySelector("#local-file")'), 'file input');
    const { root } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#local-file' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [pdfPath] });
    const translated = (n) => page.eval(`document.querySelector('[data-page="${n}"] .dst')?.textContent.includes('【译文】')`);
    const texts = (n) => page.eval(`Array.from(document.querySelectorAll('[data-page="${n}"] .src'), el => el.textContent)`);
    async function jump(n) {
      await page.eval(`document.querySelector('#page-number').value='${n}'; document.querySelector('#page-jump').requestSubmit()`);
    }
    await until(() => translated(1), 'first local page');
    assert.ok(!(await texts(1)).includes('Systems handbook / reader edition'));
    await jump(90);
    await until(() => translated(90), 'columns');
    assert.deepEqual(await texts(90), ['Section 90. Reading experiments', ...['Left', 'Right'].map(side =>
      Array.from({ length: 5 }, (_, i) => `${side} column line ${i + 1}.`).join(' '))]);
    await page.eval(`document.querySelectorAll('[data-page="90"] .source-location')[1].click()`);
    assert.equal(await page.eval(`document.querySelector('[data-page="90"] .source-hit.selected')?.dataset.index`), '1');
    await page.eval(`document.querySelector('[data-page="90"] .source-hit.selected').click()`);
    assert.ok(await page.eval(`document.activeElement.matches('[data-page="90"] .para.selected')`));
    await jump(91);
    await until(() => translated(91), 'table');
    assert.deepEqual((await texts(91)).slice(1), ['Item', 'Quantity', 'Price', 'Widget', '12', '3.50', 'Gadget', '4', '9.00']);
    await page.eval(`document.querySelector('#page-layout').value='table';document.querySelector('#page-layout').dispatchEvent(new Event('change'))`);
    await until(() => translated(91), 'table preset applied in place');
    assert.equal(await page.eval(`document.querySelector('#page-number').value`), '91');
    assert.deepEqual((await texts(91)).slice(1), ['Item', 'Quantity', 'Price', 'Widget', '12', '3.50', 'Gadget', '4', '9.00']);
    await page.eval('const mode = document.querySelector("#mode-select"); mode.value = "original"; mode.dispatchEvent(new Event("change"))');
    await jump(92);
    await until(() => page.eval(`!!document.querySelector('[data-page="92"] .ocr-page-btn')`), 'OCR button');
    await page.eval('mode.value = "bilingual"; mode.dispatchEvent(new Event("change"))');
    await page.eval(`document.querySelector('[data-page="92"] .ocr-page-btn').click()`);
    await until(() => translated(92), 'local OCR', 60000);
    assert.ok((await texts(92)).join(' ').includes('READ THE SCANNED PAGE'));
    for (const [number, expected] of [[94, 'Section 93. Reading experiments'], [96, 'Trace analysis']]) {
      await jump(number);
      await until(() => translated(number), 'continuation page ' + number);
      const body = (await texts(number))[0];
      assert.deepEqual(contexts.get(body), { title: 'Systems handbook', section: expected });
    }

    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.eval('document.querySelector("#export-btn").click()');
    const exported = path.join(downloads, path.basename(pdfPath).replace(/\.pdf$/i, '') + '.bilingual.html');
    await until(() => readFile(exported, 'utf8').catch(() => null), 'completed HTML download');
    const reopened = await browser.page(pathToFileURL(exported).href);
    await until(() => reopened.eval('document.querySelectorAll("section").length === 180'), 'all HTML pages');
    const content = await reopened.eval('document.body.innerText');
    for (const snippet of ['未读取', '【译文】', 'READ THE SCANNED PAGE']) assert.ok(content.includes(snippet));
    const slowSettings = {
      ...settings, cacheEnabled: false, translationMemory: { enabled: false }, pdfViewer: { maxConcurrentPages: 1 },
    };
    assert.ok((await config.eval('chrome.runtime.sendMessage({type:"save-settings",settings:' + JSON.stringify(slowSettings) + '})')).ok);
    let release;
    serviceGate = new Promise((r) => { release = r; });
    const callsBefore = requests;
    try {
      const slow = await browser.page(base + '/viewer/pdf-viewer.html?src=' + encodeURIComponent(origin + '/reading.pdf'));
      await until(() => requests > callsBefore, 'first page pending at Provider');
      await slow.eval('document.querySelector("#page-number").value=90; document.querySelector("#page-jump").requestSubmit()');
      await until(() => slow.eval(`document.querySelector('[data-page="90"] .src')?.textContent.includes('Section 90')`), 'original while Provider is paused', 5000);
      assert.ok(await slow.eval(`document.querySelector('[data-page="90"] canvas').height > 300`));
    } finally { release(); serviceGate = undefined; }
    console.log('Passed local reading, jump during pending translation, paragraph links, columns, cells, chapter context, real Tesseract and offline HTML.');
  }
} finally {
  try { await browser?.close(); } finally {
    server.close();
    if (path.dirname(downloads) === path.resolve(tmpdir()) && path.basename(downloads).startsWith('polypage-pdf-downloads-')) {
      await rm(downloads, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  }
}
