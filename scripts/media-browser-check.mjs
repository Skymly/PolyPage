import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openFixtureBrowser } from './chromium-fixture.mjs';

const downloads = await mkdtemp(path.join(os.tmpdir(), 'polypage-srt-'));
const clipPath = path.join(downloads, 'fixture.webm');
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
  'color=c=gray:size=320x180:rate=10', '-t', '8', '-c:v', 'libvpx', '-f', 'webm', clipPath], { windowsHide: true });
const clip = await readFile(clipPath);
const image = await readFile(new URL('./fixtures/hello-world.png', import.meta.url));
let failTranslation = false;
const server = createServer(async (req, res) => {
  if (req.url === '/translate') {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const { q } = JSON.parse(Buffer.concat(parts));
    res.writeHead(failTranslation ? 503 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ translations: q.map(s => /HELLO\s+WORLD/i.test(s) ? '你好，世界' : '译 ' + s) }));
  }
  if (req.url === '/sample.webm') {
    const start = Number(req.headers.range?.match(/^bytes=(\d+)-/)?.[1] ?? 0);
    const body = clip.subarray(start);
    res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes',
      'content-length': body.length, ...(req.headers.range ? {'content-range': `bytes ${start}-${clip.length-1}/${clip.length}`} : {}) });
    return res.end(body);
  }
  if (req.url === '/clear.png') {
    res.writeHead(200, { 'content-type': 'image/png' }); return res.end(image);
  }
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
  if (req.url === '/embed') {
    return res.end(`<!doctype html><title>Embedded player</title><iframe src="/dom-embedded" width="650" height="480"></iframe>`);
  }
  const native = req.url === '/native';
  const title = req.url === '/dom-embedded' ? 'Embedded media' : 'Media fixture';
  const youtubeWindows = req.url === '/dom-embedded' ? `
    <div class="caption-window ytp-caption-window-top">
      <span class="ytp-caption-segment" id="language-notice">Spanish</span>
      <span class="ytp-caption-segment">Click <svg><use class="ytp-svg-shadow"></use></svg> for settings</span>
    </div>
    <div class="caption-window ytp-caption-window-top">
      <span class="ytp-caption-segment" id="upper-cue">Caption above the speaker</span>
    </div>` : '';
  res.end(`<!doctype html><title>${title}</title><div id="player">
  <video width="400" height="220" src="/sample.webm" muted preload="auto"></video>
  ${native ? '' : '<span lang="en" class="ytp-caption-segment"><em>First caption</em></span>'}
  ${youtubeWindows}</div>
  <img id="clear" width="360" height="100" src="/clear.png"><img id="hard" width="240" height="100">
  <script>
  const c=document.createElement('canvas');c.width=70;c.height=22;const ctx=c.getContext('2d');
  ctx.fillStyle='#eee';ctx.fillRect(0,0,70,22);ctx.fillStyle='#ccc';ctx.font='italic 6px serif';
  ctx.rotate(-.07);ctx.fillText('Minimum 5',3,13);document.querySelector('#hard').src=c.toDataURL();
  const v=document.querySelector('video');
  ${native ? `const en=v.addTextTrack('subtitles','English','en');en.mode='showing';
  en.addCue(new VTTCue(1,3,'Hello\\nreader')); en.addCue(new VTTCue(4,7,'Second line'));
  const fr=v.addTextTrack('subtitles','French','fr');fr.mode='disabled';fr.addCue(new VTTCue(1,3,'Bonjour')); ` : ''}
  </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await openFixtureBrowser(process.argv[2] || 'dist');
const started = performance.now();
async function until(label, fn, ms = 12000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { const result = await fn(); if (result) return result; await sleep(80); }
  throw new Error('Timed out: ' + label);
}
async function click(page, x, y) {
  for (const type of ['mouseMoved','mousePressed','mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}
async function clickAx(page, name) {
  const nodes = (await page.send('Accessibility.getFullAXTree')).nodes;
  const button = nodes.find(n => n.role?.value === 'button' && n.name?.value === name);
  assert.ok(button, 'button: ' + name);
  const { model } = await page.send('DOM.getBoxModel', { backendNodeId: button.backendDOMNodeId });
  const [x, y,, , x2, y2] = model.content;
  await click(page, (x+x2)/2, (y+y2)/2);
}
const extBase = 'chrome-extension://' + browser.extensionId;
try {
  const opts = await browser.page(extBase + '/options/options.html');
  await until('settings', () => opts.eval('document.readyState === "complete"'));
  const settings = { schemaVersion: 4, activeProviderId: 'local', providers: [{
    id:'local',name:'Fixture Text',type:'custom-http',enabled:true,baseUrl:origin+'/translate',
    method:'POST',bodyTemplate:'{"q":{{texts}}}',responsePath:'translations',
    sourceLanguage:'auto',targetLanguage:'简体中文',timeoutMs:3000,maxBatchItems:10,maxBatchChars:4000,
  }], imageTranslate:{enabled:true,trigger:'both',engine:'tesseract-wasm',tessLangs:['eng']},
  imageOverlay:{enabled:true}, siteRules:[{id:'custom-fixture',match:['127.0.0.1'],subtitleSelectors:['.ytp-caption-segment']}],
  autoTranslate:false,cacheEnabled:false };
  const saved = await opts.eval(`chrome.runtime.sendMessage({ type:'save-settings', settings:${JSON.stringify(settings)}})`);
  assert.equal(saved.ok,true);
  const popup = await browser.page('about:blank');
  async function popupFor(page) {
    await browser.send('Target.activateTarget', { targetId:page.targetId });
    await popup.send('Page.navigate', { url:extBase+'/popup/popup.html?test='+Date.now() });
    await until('popup ready', () => popup.eval("document.querySelector('#info-progress')?.textContent.includes('个段落') && !document.querySelector('#btn-toggle-subtitles')?.classList.contains('hidden')"), 20000).catch(async error => {
      console.log('Popup diagnostics', await popup.eval('document.body.innerText.slice(0,600)'), await page.eval('document.readyState'));
      throw error;
    });
  }
  async function command(page, type) {
    return opts.eval(`(async()=>{ const t=(await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(await page.eval('location.href'))});return chrome.tabs.sendMessage(t.id,{type:${JSON.stringify(type)}},{frameId:0}) })()`);
  }
  await browser.send('Browser.setDownloadBehavior', {behavior:'allow',downloadPath:downloads});
  const native = await browser.page(origin + '/native');
  const box = 'document.querySelector(".wt-subtitle-host")?.shadowRoot?.querySelector(".wt-sub-dst")?.textContent';
  await until('video ready',()=>native.eval('document.querySelector("video")?.readyState >= 2'));
  await popupFor(native);
  await popup.eval("document.querySelector('#btn-toggle-subtitles').click()");
  await until('native subtitle layer',()=>native.eval('!!document.querySelector(".wt-subtitle-host")'));
  const firstCue = performance.now();
  await native.eval('v.currentTime = 1.2');
  await until('first translation',()=>native.eval(box+' === "译 Hello reader"')).catch(async error => {
    console.log('Native fixture diagnostics', await native.eval('({time:v.currentTime,duration:v.duration,ready:v.readyState,modes:Array.from(v.textTracks,t=>[t.mode,t.cues?.length]),box:document.querySelector(".wt-subtitle-host")?.shadowRoot?.textContent.slice(-110)})'));
    throw error;
  });
  const cueMs = Math.round(performance.now() - firstCue);
  await native.eval('v.currentTime = 4.2');
  await until('seek translation',()=>native.eval(box+' === "译 Second line"'));
  await native.send('Runtime.evaluate',{expression:'player.requestFullscreen()',userGesture:true,awaitPromise:true});
  assert.ok(await until('player fullscreen',()=>native.eval('document.fullscreenElement === player && !!player.querySelector(".wt-subtitle-host")')));
  await native.eval('document.exitFullscreen()');
  await native.send('Runtime.evaluate',{expression:'v.requestFullscreen()',userGesture:true,awaitPromise:true});
  await until('native video fullscreen cue', () => native.eval(`document.fullscreenElement === v &&
    document.querySelector('.wt-subtitle-host')?.matches(':popover-open') && ${box} === "译 Second line"`));
  await native.eval('document.exitFullscreen()');
  await until('export button',()=>popup.eval('!!document.querySelector("#btn-export-srt")?.offsetWidth'));
  await popup.eval('document.querySelector("#btn-export-srt").click()');
  const srt = await until('saved srt',()=>readFile(path.join(downloads, 'Media fixture.bilingual.srt'),'utf8').catch(()=>null));
  assert.equal(srt, '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\nHello\r\nreader\r\n译 Hello reader\r\n\r\n2\r\n00:00:04,000 --> 00:00:07,000\r\nSecond line\r\n译 Second line\r\n');
  await native.eval('en.mode="disabled"; fr.mode="showing"; v.currentTime=1.4');
  await until('language switch',()=>native.eval(box+' === "译 Bonjour"'));
  await popup.eval('document.querySelector("#btn-toggle-subtitles").click()');
  await until('restored French track',()=>native.eval('!document.querySelector(".wt-subtitle-host") && en.mode==="disabled" && fr.mode==="showing"'));
  console.log('Native video: English + French, seek, player and native fullscreen, SRT download and restore passed.', {cueMs});

  const dom = await browser.page(origin+'/dom');
  await until('caption fixture ready',()=>dom.eval('!!document.querySelector(".ytp-caption-segment")'));
  const cap = 'document.querySelector(".ytp-caption-segment")';
  await until('self drawn translation',()=>dom.eval(cap+'.dataset.wtCaptionTranslation === "译 First caption"'));
  await dom.eval('v.play()');
  await sleep(600);
  await dom.eval(`${cap}.lang="fr"; ${cap}.firstChild.textContent="Premier sous-titre"`);
  await until('reused caption',()=>dom.eval(cap+'.dataset.wtCaptionTranslation === "译 Premier sous-titre"'));
  await sleep(450);
  await dom.eval('v.currentTime=4.3');
  await dom.eval(`${cap}.firstChild.textContent="Après le saut"`);
  await until('after seek',()=>dom.eval(cap+'.dataset.wtCaptionTranslation === "译 Après le saut"'));
  await dom.send('Runtime.evaluate',{expression:'player.requestFullscreen()',userGesture:true,awaitPromise:true});
  await until('self drawn fullscreen',()=>dom.eval(`document.fullscreenElement===player && getComputedStyle(${cap},"::after").content.includes("译")`));
  await sleep(400);
  await dom.eval('v.pause(); document.exitFullscreen()');
  const domSrt = (await command(dom,'wt:export-srt')).srt;
  assert.match(domSrt,/Premier sous-titre/); assert.match(domSrt,/Après le saut/); assert.doesNotMatch(domSrt,/First caption/);
  await popupFor(dom);
  await popup.eval('document.querySelector("#btn-toggle-subtitles").click()');
  await until('custom captions restored',()=>dom.eval(`!${cap}.hasAttribute("data-wt-caption-translation") && ${cap}.firstChild.tagName==="EM" && ${cap}.textContent==="Après le saut"`));
  console.log('DOM captions: language change, reused element, seek, fullscreen, observed-time export and restoration passed.',JSON.stringify(domSrt));

  const embedded = await browser.page(origin + '/embed');
  const withinFrame = expression => embedded.eval(`(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const caption = doc?.querySelector('.ytp-caption-segment');
    const video = doc?.querySelector('video');
    return ${expression};
  })()`);
  await until('embedded subtitle translation', () => withinFrame('caption?.dataset.wtCaptionTranslation === "译 First caption"'));
  await until('top-positioned video cue translation', () =>
    withinFrame('doc.querySelector("#upper-cue").dataset.wtCaptionTranslation === "译 Caption above the speaker"'));
  assert.equal(await withinFrame('doc.querySelector("#language-notice").hasAttribute("data-wt-caption-translation")'), false);
  await withinFrame('video.play()');
  await until('embedded subtitle has a playback interval', () => withinFrame('video.currentTime > 0.5'));
  await popupFor(embedded);
  assert.equal(await popup.eval('document.querySelector("#btn-toggle-subtitles").textContent'), '关闭字幕翻译');
  await popup.eval('document.querySelector("#btn-export-srt").click()');
  const embeddedSrt = await until('embedded subtitle download', () =>
    readFile(path.join(downloads, 'Embedded media.bilingual.srt'), 'utf8').catch(() => null));
  assert.match(embeddedSrt, /First caption\r\n译 First caption/);
  assert.match(embeddedSrt, /Caption above the speaker\r\n译 Caption above the speaker/);
  assert.doesNotMatch(embeddedSrt, /Spanish|Click for settings/);
  await popup.eval('document.querySelector("#btn-toggle-subtitles").click()');
  await until('embedded source restored', () => withinFrame('caption?.textContent === "First caption" && !caption.hasAttribute("data-wt-caption-translation")'));
  console.log('Embedded player: popup download and source restoration passed.');

  await browser.send('Target.activateTarget',{targetId:dom.targetId});
  await browser.send('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  async function hoverImage(id) {
    const [x,y]=await dom.eval(`(()=>{ const r=document.getElementById('${id}').getBoundingClientRect();return [r.x+5,r.y+40] })()`);
    await dom.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await until('OCR routing label',()=>dom.eval('document.querySelector(".wt-img-btn")?.textContent.includes("本机识别，文字发给 Fixture Text")'));
    await clickAx(dom,'译图 · 本机识别，文字发给 Fixture Text');
  }
  const panelText = async () => (await command(dom,'wt:get-state')).ocrPanelText;
  const coldStart = performance.now();
  await hoverImage('clear');
  await until('first local OCR', async()=>(await panelText()).includes('你好，世界'), 40000);
  const coldOcrMs = Math.round(performance.now() - coldStart);
  await clickAx(dom,'收起');
  failTranslation = true;
  await hoverImage('clear');
  await until('OCR failure and retry',async()=>(await panelText()).includes('重试'),40000);
  failTranslation = false;
  const retried = performance.now();
  await clickAx(dom,'重试');
  const clear = await until('recognized and translated',async()=> { const t=await panelText(); return t.includes('你好，世界') && t; },40000);
  assert.match(clear,/HELLO\s+WORLD/i);
  const ocrMs=Math.round(performance.now()-retried);
  assert.ok(await dom.eval('!!document.querySelector(".wt-ocr-overlay-host")'));
  await clickAx(dom,'复制全部');
  assert.match(await dom.eval('navigator.clipboard.readText()'),/HELLO\s+WORLD -> 你好，世界/i);
  await clickAx(dom,'收起');
  assert.equal(await dom.eval('!!document.querySelector(".wt-ocr-host,.wt-ocr-overlay-host")'),false);
  await hoverImage('hard');
  const hard = await until('difficult OCR',async()=>{const t=await panelText();return t && !t.includes('正在') && t;},40000);
  await clickAx(dom,'收起');
  console.log('Local WASM OCR, fixed local translation, retry, clipboard and overlay close passed.', JSON.stringify({clear,coldOcrMs,ocrMs,hard}));
  console.log('Media browser checks passed in',Math.round(performance.now()-started),'ms');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  if (path.dirname(downloads) === path.resolve(os.tmpdir()) && path.basename(downloads).startsWith('polypage-srt-')) await rm(downloads,{recursive:true,force:true});
}
