/** Live YouTube acceptance check. Requires Edge, network access and a public
 * watch video with captions. A second authored track is preferred, with
 * YouTube's own auto-translate control as fallback. No site captions
 * are supplied by this script. Use --baseline to observe the native player
 * without the extension, or --self-test for offline protocol checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openFixtureBrowser } from './chromium-fixture.mjs';

function parseOptions(args) {
  const supplied = new URL(args[0]);
  if (supplied.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(supplied.hostname) ||
      supplied.pathname !== '/watch' || supplied.username || supplied.password || supplied.port) throw Error('watch-url');
  const id = supplied.searchParams.get('v');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id ?? '')) throw Error('video-id');
  const options = { url: 'https://www.youtube.com/watch?v=' + id + '&hl=en', baseline: false, headed: false, singleTrack: false, keep: null, dist: 'dist' };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--baseline') options.baseline = true;
    else if (args[i] === '--headed') options.headed = true;
    else if (args[i] === '--single-track') options.singleTrack = true;
    else if (args[i] === '--keep-srt' && args[i + 1] && !args[i + 1].startsWith('--')) options.keep = path.resolve(args[++i]);
    else if (args[i] === '--extension' && args[i + 1] && !args[i + 1].startsWith('--')) options.dist = path.resolve(args[++i]);
    else throw Error('arguments');
  }
  return options;
}

const normal = s => s.trim().replace(/\s+/g, ' ');
function translation(source) {
  return '测试译文 ' + createHash('sha256').update(normal(source)).digest('hex').slice(0, 10);
}

function manualTrack(label) {
  return Boolean(label.trim()) && !/(^off$|^settings$|^options$|^none$|auto[- ]?(generated|translate|translated)|automatic|自动|自動|关闭|關閉)/i.test(label.trim());
}

function validateSrt(bytes, observed, requiredTranslation) {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const blocks = text.trim().split(/\r\n\r\n/);
  const time = s => {
    const m = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(s);
    assert.ok(m);
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  };
  let prev = -1, sawCurrent = false;
  for (const [i, block] of blocks.entries()) {
    const [index, timing, ...lines] = block.split('\r\n');
    assert.equal(index, String(i + 1));
    const [start, end] = timing.split(' --> ').map(time);
    assert.ok(start >= prev && end > start);
    prev = start;
    const dst = lines.pop();
    const source = normal(lines.join(' '));
    assert.ok(source && observed.has(source) && dst === translation(source));
    if (dst === requiredTranslation) sawCurrent = true;
  }
  assert.ok(sawCurrent);
  return blocks.length;
}

const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const movie = () => document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
const video = () => movie()?.querySelector('video.html5-main-video,video') || document.querySelector('video');
const menuRows = () => Array.from(movie()?.querySelectorAll('.ytp-settings-menu .ytp-menuitem') ?? []).filter(visible);
const menuLabel = el => (el.querySelector('.ytp-menuitem-label')?.textContent ?? el.textContent ?? '').trim();
function currentCues() {
  const rows = Array.from(movie()?.querySelectorAll('.ytp-caption-segment') ?? []).filter(visible);
  const cues = rows.map(el => {
    const source = el.textContent?.trim() || '';
    const translated = el.getAttribute('data-wt-caption-translation') || '';
    const pseudo = getComputedStyle(el, '::after');
    return { source, dst: translated && pseudo.display !== 'none' && pseudo.visibility !== 'hidden' && pseudo.content.includes(translated) ? translated : '' };
  }).filter(row => row.source);
  const track = Array.from(video()?.textTracks ?? []).find(t => t.label !== 'PolyPage' && /^(captions|subtitles)$/.test(t.kind) && t.mode !== 'disabled' && t.activeCues?.length);
  if (track) {
    const text = Array.from(track.activeCues, c => c.text?.replace(/<[^>]*>/g, '').trim()).filter(Boolean).join(' ');
    const layer = document.querySelector('.wt-subtitle-host')?.shadowRoot;
    const source = layer?.querySelector('.wt-sub-src')?.textContent || '';
    const dst = layer?.querySelector('.wt-sub-dst')?.textContent || '';
    cues.push({ source: text, dst: source === text ? dst : '' });
  }
  return cues;
}
// All page observers return narrowly selected data. Never emit a watch URL,
// player payload, caption body, request, response, cookies or CDP error text.
const inPage = fn => '(() => {const visible=' + visible + ',movie=' + movie + ',video=' + video + ',menuRows=' + menuRows + ',menuLabel=' + menuLabel + ',currentCues=' + currentCues + ';return (' + fn + ')();})()';
async function diagnostics(page) {
  return page.eval(inPage(() => {
    const v = video(), p = movie();
    const status = window.ytInitialPlayerResponse?.playabilityStatus?.status;
    const allowed = ['OK','ERROR','UNPLAYABLE','LOGIN_REQUIRED','AGE_CHECK_REQUIRED','CONTENT_CHECK_REQUIRED','LIVE_STREAM_OFFLINE'];
    return {
      player: !!p, video: !!v, readyState: v?.readyState, networkState: v?.networkState, mediaError: v?.error?.code,
      mediaTime: Math.round(v?.currentTime || 0), paused: v?.paused, ad: !!p?.classList.contains('ad-showing'),
      consentPage: location.hostname === 'consent.youtube.com' || location.hostname === 'consent.google.com',
      playability: allowed.includes(status) ? status : 'unknown', frames: document.querySelectorAll('iframe').length,
      ccControl: visible(p?.querySelector('.ytp-subtitles-button')), ccPressed: p?.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
      tracks: v?.textTracks?.length ?? 0, segments: p?.querySelectorAll('.ytp-caption-segment').length ?? 0,
      sourceVisible: currentCues().some(c => !!c.source), translatedVisible: currentCues().some(c => !!c.dst),
      shownMenuRows: menuRows().length, fullscreen: !!document.fullscreenElement,
    };
  }));
}
async function waitFor(check, ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const result = await check(); if (result) return result; await sleep(120); }
  throw Error('timeout');
}
async function clickAt(page, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent',
    { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
}
async function clickElement(page, expression, position = 0.5) {
  const point = await waitFor(() => page.eval(inPage('()=>{const el=' + expression + ';if(!visible(el))return;el.scrollIntoView({block:"nearest",inline:"nearest"});const r=el.getBoundingClientRect();const x=r.left+r.width*' + position + ', y=r.top+r.height*.5;return x>=0 && y>=0 && x<innerWidth && y<innerHeight ? [x,y] : null;}')));
  await clickAt(page, ...point);
}
async function revealControls(page) {
  const [x,y] = await page.eval(inPage(() => { const r=movie().getBoundingClientRect(); return [r.left+r.width*.44,r.top+r.height*.64]; }));
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
}
async function startPlayback(page) {
  await revealControls(page);
  if (await page.eval(inPage(() => video()?.paused))) await clickElement(page, "movie().querySelector('.ytp-play-button')");
  const from = await page.eval(inPage(() => video()?.currentTime ?? 0));
  await waitFor(() => page.eval(inPage('()=> !movie()?.classList.contains("ad-showing") && !video()?.paused && video()?.currentTime > ' + from + ' + .25')), 30000);
}

async function languageMenu(page) {
  await revealControls(page);
  await clickElement(page, "movie().querySelector('.ytp-settings-button')");
  // YouTube sometimes remembers the last submenu.
  const list = await waitFor(() => page.eval(inPage(() => menuRows().length ? menuRows().map(el => ({label:menuLabel(el), role:el.getAttribute('role')})) : null)));
  if (!list.some(item => item.role === 'menuitemradio' && /^(off|关闭|關閉)$/i.test(item.label))) {
    await clickElement(page, "menuRows().find(el=>/subtitles|captions|字幕/i.test(menuLabel(el)))");
  }
  return waitFor(() => page.eval(inPage(() => {
    const radios = menuRows().filter(el => el.getAttribute('role') === 'menuitemradio');
    return radios.length ? radios.map(el => ({ label: menuLabel(el), checked: el.getAttribute('aria-checked') === 'true' })) : null;
  })));
}
async function chooseLanguage(page, prior, allowSingle = false) {
  const radios = await languageMenu(page);
  const tracks = radios.filter(r => manualTrack(r.label));
  let target = prior ? tracks.find(r => r.label !== prior.label) : tracks.find(r => r.checked) ?? tracks[0];
  let kind = 'manual';
  if (!target && !prior) {
    target = radios.find(r => /auto[- ]?generated|自动生成|自動生成/i.test(r.label));
    kind = 'site-generated';
  }
  if (target) {
    await clickElement(page, 'menuRows().find(el => el.getAttribute("role")==="menuitemradio" && menuLabel(el)===' + JSON.stringify(target.label) + ')');
  } else if (prior) {
    const auto = await page.eval(inPage(() => menuRows().some(el =>
      /auto[- ]?translate|自动翻译|自動翻譯/i.test(menuLabel(el)))));
    const offered = radios.filter(r => manualTrack(r.label) || /auto[- ]?generated|自动生成|自動生成/i.test(r.label));
    if (allowSingle && !auto && offered.length === 1 && offered[0].label === prior.label) {
      await clickElement(page, "movie().querySelector('.ytp-settings-button')");
      console.log(JSON.stringify({languageSwitch:'unavailable',offeredTracks:1,autoTranslateOption:false}));
      return null;
    }
    await clickElement(page, "menuRows().find(el=>/auto[- ]?translate|自动翻译|自動翻譯/i.test(menuLabel(el)))");
    const candidates = await waitFor(() => page.eval(inPage(() => {
      const labels = menuRows().map(menuLabel);
      return labels.some(l => /^(spanish|french|西班牙语|西班牙文|法语|法文)$/i.test(l)) && labels;
    })));
    const label = candidates.find(l => /^(spanish|西班牙语|西班牙文)$/i.test(l) && !prior.label.toLowerCase().includes(l.toLowerCase()))
      ?? candidates.find(l => /^(french|法语|法文)$/i.test(l));
    if (!label) throw Error('no-second-language');
    target = { label };
    kind = 'site-auto-translate';
    await clickElement(page, 'menuRows().find(el=>menuLabel(el)===' + JSON.stringify(label) + ')');
  } else throw Error('no-source-track');
  // Selecting a language can leave the settings root open.
  if (await page.eval(inPage(() => menuRows().length > 0))) await clickElement(page, "movie().querySelector('.ytp-settings-button')");
  const selected = await selectedLanguage(page);
  return { label: target.label, kind, selected };
}

async function selectedLanguage(page) {
  return page.eval(inPage(() => {
    const track = movie()?.getOption?.('captions','track');
    const code = track?.translationLanguage?.languageCode ?? track?.languageCode ??
      movie()?.querySelector('.ytp-caption-segment')?.closest('[lang]')?.getAttribute('lang');
    return /^[a-z]{2,3}(-[a-z\d]{2,8})*$/i.test(code ?? '') ? code : null;
  }));
}

function seekPosition(clock) {
  if (clock.live || !Number.isFinite(clock.length)) {
    if (!(clock.end - clock.start >= 12)) throw Error('no-dvr-window');
    // Prefer an absolute point about 36 seconds behind the current live edge.
    return { target: clock.end - Math.min(36, (clock.end - clock.start) * .75), dvr: true };
  }
  if (!(clock.length >= 8)) throw Error('not-seekable');
  return { target: clock.length * (clock.time / clock.length < .5 ? .65 : .30), dvr: false };
}

async function seekPlayer(page) {
  const readClock = () => page.eval(inPage(() => {
    const v = video(), r = v.seekable;
    return { time: v.currentTime, length: Number.isFinite(v.duration) ? v.duration : null,
      live: movie().classList.contains('ytp-live') || visible(movie().querySelector('.ytp-live-badge')),
      start: r?.length ? r.start(r.length - 1) : 0, end: r?.length ? r.end(r.length - 1) : 0 };
  }));
  const clock = await readClock();
  const {target, dvr} = seekPosition(clock);
  if (dvr) {
    // For long live windows a progress-bar pixel can represent minutes.
    // Seek the real media clock through its native API at sub-pixel precision.
    await page.eval(inPage('()=>{video().currentTime=' + target + ';}'));
  } else {
    await revealControls(page);
    await clickElement(page,"movie().querySelector('.ytp-progress-bar')",target/clock.length);
  }
  const after = await waitFor(async () => {
    const next = await readClock();
    const tolerance = dvr ? 7 : Math.max(3, clock.length / 150);
    return Math.abs(next.time - target) <= tolerance && Math.abs(next.time - clock.time) > 2 &&
      await page.eval(inPage(() => !video().seeking)) && next;
  });
  console.log(JSON.stringify({seek:dvr?'DVR':'VOD',fromSeconds:Math.round(clock.time),targetSeconds:Math.round(target),
    landedSeconds:Math.round(after.time),...(dvr ? {behindLiveEdgeSeconds:Math.round(after.end-after.time)} : {})}));
}

async function live(options) {
  let browser, server, page, settings, temp, phase = 'browser';
  const observed = new Set();
  let calls = 0;
  const step = next => {phase=next;console.log('Checking', next);};
  try {
    browser = await openFixtureBrowser(options.baseline ? null : options.dist, { headless: !options.headed });
    if (!options.baseline) {
      temp = await mkdtemp(path.join(tmpdir(),'polypage-youtube-'));
      server = createServer(async (req,res) => {
        if (req.method !== 'POST' || req.url !== '/translate') { res.writeHead(404).end(); return; }
        try {
          let body='';for await (const c of req) { body+=c; if(body.length>200000) throw Error(); }
          const {q}=JSON.parse(body);if(!Array.isArray(q)||q.some(s=>typeof s!=='string')) throw Error();
          calls++;
          for(const s of q) observed.add(normal(s));
          res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({translations:q.map(translation)}));
        } catch { res.writeHead(400).end(); }
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const base='chrome-extension://'+browser.extensionId;
      settings=await browser.page(base+'/options/options.html');
      await waitFor(()=>settings.eval('!!document.querySelector(".provider-row")'));
      const conf={schemaVersion:6,autoTranslate:false,cacheEnabled:false,translationMemory:{enabled:false},activeProviderId:'yt-check',
        providers:[{id:'yt-check',type:'custom-http',name:'YouTube local check',enabled:true,baseUrl:'http://127.0.0.1:'+server.address().port+'/translate',method:'POST',bodyTemplate:'{"q":{{texts}}}',responsePath:'translations',sourceLanguage:'auto',targetLanguage:'简体中文'}]};
      assert.ok((await settings.eval('chrome.runtime.sendMessage({type:"save-settings",settings:'+JSON.stringify(conf)+'})')).ok);
      await browser.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:temp});
    }
    step('watch-player');
    page=await browser.page(options.url);
    await waitFor(()=>page.eval(inPage(()=>!!movie() && !!video())),options.headed ? 45000 : 25000);
    step('main-video-playback');await startPlayback(page);
    step('native-CC-control');await revealControls(page);
    await waitFor(()=>page.eval(inPage(()=>visible(movie()?.querySelector('.ytp-subtitles-button')))));
    if(await page.eval(inPage(()=>movie().querySelector('.ytp-subtitles-button').getAttribute('aria-pressed') !== 'true'))) {
      await clickElement(page,"movie().querySelector('.ytp-subtitles-button')");
    }
    step('first-site-language');const first=await chooseLanguage(page,null);
    step('first-native-source');
    const sources=()=>page.eval(inPage(currentCues));
    await waitFor(async()=>(await sources()).some(row=>row.source),22000);
    if(options.baseline) {
      step('native-second-language');const second=await chooseLanguage(page,first,options.singleTrack);
      await waitFor(async()=>(await sources()).some(row=>row.source),22000);
      console.log(JSON.stringify({baseline:true,nativeSourceVisible:true,firstTrack:first.kind,secondTrack:second?.kind??null}));return;
    }
    const base='chrome-extension://'+browser.extensionId;
    async function openPopup(){
      await browser.send('Target.activateTarget',{targetId:page.targetId});
      await settings.eval('chrome.action.openPopup().then(()=>true)');
      const target=await waitFor(async()=>(await browser.send('Target.getTargets')).targetInfos.find(t=>t.url===base+'/popup/popup.html'));
      return browser.attach(target.targetId);
    }
    const closePopup=async popup=>{
      await popup.send('Runtime.evaluate',{expression:'window.close()'}).catch(()=>undefined);
      await browser.send('Target.activateTarget',{targetId:page.targetId});
    };
    step('popup-subtitle-state');
    let popup=await openPopup();
    const toggle='#btn-toggle-subtitles';
    const label=await waitFor(()=>popup.eval('document.querySelector("'+toggle+'")?.offsetWidth && document.querySelector("'+toggle+'").textContent'));
    if (!label.includes('关闭')) await clickElement(popup,'document.querySelector("'+toggle+'")');
    await closePopup(popup);
    const paired = async()=>(await sources()).find(row=>row.source && observed.has(normal(row.source)) && row.dst === translation(row.source));
    step('first-visible-translation');await waitFor(paired,25000);
    step('second-site-language');
    const beforeSwitch=new Set((await sources()).map(r=>normal(r.source)));
    const second=await chooseLanguage(page,first,options.singleTrack);
    if(second){
      assert.notEqual(first.label,second.label);
      step('second-language-visible-translation');
      await waitFor(async()=>{const r=await paired();return r&&!beforeSwitch.has(normal(r.source));},25000);
    }
    step('player-seek');await seekPlayer(page);
    step('post-seek-translation');await waitFor(paired,25000);
    step('player-fullscreen');await revealControls(page);
    await clickElement(page,"movie().querySelector('.ytp-fullscreen-button')");
    await waitFor(()=>page.eval(inPage(()=>!!document.fullscreenElement && document.fullscreenElement.contains(video()))));
    const required=await waitFor(paired,25000);
    await sleep(500);
    await revealControls(page);await clickElement(page,"movie().querySelector('.ytp-fullscreen-button')");
    await waitFor(()=>page.eval('!document.fullscreenElement'));
    step('popup-export');popup=await openPopup();
    await clickElement(popup,'document.querySelector("#btn-export-srt")');
    const file=await waitFor(async()=>{const files=await readdir(temp);return files.find(n=>n.endsWith('.srt'));});
    const bytes=await readFile(path.join(temp,file));
    const count=validateSrt(bytes,observed,required.dst);
    if(options.keep){
      await mkdir(options.keep,{recursive:true});
      const name='youtube-'+Date.now()+'.bilingual.srt';
      await writeFile(path.join(options.keep,name),bytes,{flag:'wx'});
      console.log('Saved SRT:',name);
    }
    step('restore-native-source');await clickElement(popup,'document.querySelector("#btn-toggle-subtitles")');
    await closePopup(popup);
    await waitFor(async()=>{const cues=await sources();return cues.some(c=>c.source)&&!cues.some(c=>c.dst);});
    assert.ok(await page.eval(inPage(()=>!movie().querySelector('[data-wt-caption-translation]')&&!document.querySelector('.wt-subtitle-host'))));
    console.log(JSON.stringify({result:'passed',firstTrack:first.kind,secondTrack:second?.kind??null,providerCalls:calls,srtCues:count,sourceRestored:true}));
  } catch {
    const state=page ? await diagnostics(page).catch(()=>({pageUnavailable:true})) : {};
    console.error(JSON.stringify({result:'blocked',stage:phase,providerCalls:calls,...state}));
    process.exitCode=1;
  } finally {
    await browser?.close();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(temp && path.dirname(temp)===path.resolve(tmpdir()) && path.basename(temp).startsWith('polypage-youtube-')) await rm(temp,{recursive:true,force:true});
  }
}

function selfTest(){
  const id='EWX0bbGAd0k';
  assert.equal(parseOptions(['https://www.youtube.com/watch?v='+id+'&list=discard','--baseline']).url,'https://www.youtube.com/watch?v='+id+'&hl=en');
  assert.throws(()=>parseOptions(['https://youtube.com.other.example/watch?v='+id]));
  assert.throws(()=>parseOptions(['https://name:password@youtube.com/watch?v='+id]));
  for(const s of ['Off','English (auto-generated)','Auto-translate','自动翻译']) assert.equal(manualTrack(s),false);
  for(const s of ['English','中文（简体）','Español']) assert.equal(manualTrack(s),true);
  const t=translation('Hello reader'),sample=Buffer.from('\uFEFF1\r\n00:00:01,020 --> 00:00:03,030\r\nHello\r\nreader\r\n'+t+'\r\n');
  assert.equal(validateSrt(sample,new Set(['Hello reader']),t),1);
  assert.throws(()=>validateSrt(sample,new Set(),t));
  assert.throws(()=>validateSrt(sample.subarray(3),new Set(['Hello reader']),t));
  assert.throws(()=>validateSrt(Buffer.from(sample.toString().replace('00:00:03,030','00:00:00,000')),new Set(['Hello reader']),t));
  assert.throws(()=>validateSrt(sample,new Set(['Hello reader']),'other'));
  assert.deepEqual(seekPosition({time:3998,length:null,end:4000,start:1700,live:true}),{dvr:true,target:3964});
  assert.throws(()=>seekPosition({time:999,end:999,start:995,live:true}));
  assert.deepEqual(seekPosition({time:10,length:100,live:false}),{dvr:false,target:65});
  console.log('YouTube observer offline checks passed: watch URL, authored-track filter, SRT encoding, cue pairing, times and current translation.');
}

export { normal, translation, validateSrt, waitFor, clickElement, inPage, currentCues };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--self-test') selfTest();
  else {
    try { await live(parseOptions(process.argv.slice(2))); }
    catch { console.error('Usage: node scripts/youtube-subtitles-check.mjs <https://www.youtube.com/watch?v=VIDEO_ID> [--headed] [--baseline] [--single-track] [--extension dist] [--keep-srt DIRECTORY]'); process.exitCode = 1; }
  }
}
