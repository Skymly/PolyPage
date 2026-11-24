/**
 * npm run build && node scripts/draft-browser-check.mjs
 * EDGE_PATH selects Chromium. DRAFT_REACT_MODULES optionally supplies a
 * local node_modules with React 18 and react-dom to exercise React's onChange.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openFixtureBrowser } from './chromium-fixture.mjs';

const reactDir = process.env.DRAFT_REACT_MODULES;
const issue = 'Why does the build sometimes fail after an update?';
const chineseIssue = '更新后为什么有时会构建失败？';
const draft = '> quoted issue\n我已复现\n`npm test`\n```js\nrun()\n```';
const translated = draft.replace('我已复现', 'I reproduced it.');
const translations = { [issue]: chineseIssue, '我已复现': 'I reproduced it.', '修复': 'fix', '谢谢': 'Thanks' };
const requests = [];
let mode = 'ok';
const html = `<!doctype html><meta charset="utf-8"><title>Build issue</title>
  <p id="issue">${issue}</p>
  <label>Comment <span id="mount"></span></label><output id="model"></output>
  <p><input id="plain"><input id="pw" type="password"></p>
  <div id="rich" contenteditable><blockquote>quoted</blockquote><strong>谢谢</strong><code>main()</code></div>
  ${reactDir ? '<script src="/react"></script><script src="/react-dom"></script>' : ''}
  <script>
    window.compositions = [];
    for (const name of ['compositionstart','compositionend']) document.addEventListener(name, () => compositions.push(name));
    if (window.React) {
      function Reply() {
        const [value, change] = React.useState('');
        model.textContent = value;
        return React.createElement('textarea', { id:'reply', value, onChange: e => change(e.target.value) });
      }
      ReactDOM.createRoot(mount).render(React.createElement(Reply));
    } else {
      mount.appendChild(Object.assign(document.createElement('textarea'), { id:'reply' }));
      reply.addEventListener('input', () => model.textContent = reply.value);
    }
    rich.addEventListener('input', () => rich.dataset.model = rich.innerHTML);
  </script>`;

const server = createServer(async (req, res) => {
  if (reactDir && ['/react', '/react-dom'].includes(req.url)) {
    const pkg = req.url.slice(1);
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(path.join(reactDir, pkg, 'umd', pkg + '.production.min.js')));
    return;
  }
  if (req.url !== '/translate') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const query = JSON.parse(body);
  requests.push(query);
  const behavior = mode;
  if (behavior === 'slow') await delay(350);
  if (behavior === 'timeout') await delay(2400);
  res.setHeader('Content-Type', 'application/json');
  if (behavior === 'fail') {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'fixture rejected request' }));
  } else {
    res.end(JSON.stringify({ texts: query.texts.map(s => translations[s] || 'Reply') }));
  }
});

const listening = once(server, 'listening');
server.listen(0, '127.0.0.1');
await listening;
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await openFixtureBrowser(process.argv[2] || 'dist');
async function until(check, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error('Timed out: ' + label);
}
try {
  const ext = await browser.page('chrome-extension://' + browser.extensionId + '/options/options.html');
  await until(() => ext.eval('typeof chrome !== "undefined" && Boolean(chrome.storage)'), 'extension page');
  await until(() => ext.eval("chrome.storage.local.get('settings').then(x => !!x.settings)"), 'installed');
  const configured = await ext.eval(`(async () => {
    const {settings:s} = await chrome.runtime.sendMessage({type:'get-full-settings'});
    s.autoTranslate = true; s.cacheEnabled = false; s.selectionTranslate = 'off';
    s.defaultTargetLanguage = '简体中文'; s.draftTargetLanguage = '英语';
    s.providers = [{...s.providers[0],id:'fixture',name:'Fixture',type:'custom-http',
      baseUrl:'${origin}/translate',apiKey:'',targetLanguage:'简体中文',sourceLanguage:'English',
      timeoutMs:1000,bodyTemplate:'{"texts":{{texts}},"src":"{{sourceLanguage}}","dst":"{{targetLanguage}}"}',
      responsePath:'texts'}];
    s.activeProviderId='fixture';
    return (await chrome.runtime.sendMessage({type:'save-settings',settings:s})).ok;
  })()`);
  assert.equal(configured, true);
  const p = await browser.page(origin + '/issue');
  const shadow = "document.querySelector('.wt-draft-host')?.shadowRoot";
  const message = `${shadow}?.querySelector('output')?.textContent ?? ''`;
  const buttons = label => `[...(${shadow}?.querySelectorAll('button') || [])].find(b => b.textContent.startsWith(${JSON.stringify(label)}))`;
  async function click(label) {
    const expr = buttons(label);
    await until(() => p.eval(`Boolean(${expr})`), label);
    const {x,y} = await p.eval(`(() => { const r=(${expr}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    for (const type of ['mousePressed','mouseReleased']) {
      await p.send('Input.dispatchMouseEvent', {type,x,y,button:'left',clickCount:1});
    }
  }
  const insert = text => p.send('Input.insertText', {text});
  async function fillReply(text) {
    await p.eval("reply.focus();reply.select()");
    await insert(text);
  }

  await until(() => p.eval(`document.body?.innerText.includes(${JSON.stringify(chineseIssue)})`), 'read English issue in Chinese');
  await fillReply(draft);
  await p.eval('reply.setSelectionRange(4,4)');
  const started = performance.now();
  await click('预览翻译');
  await until(() => p.eval(`(${message}) === ${JSON.stringify(translated)}`), 'preview');
  const previewMs = Math.round(performance.now() - started);
  assert.equal(await p.eval('reply.value'), draft);
  await click('替换草稿');
  assert.deepEqual(await p.eval('[reply.value,model.textContent]'), [translated,translated]);
  await click('撤销替换');
  assert.deepEqual(await p.eval('[reply.value,model.textContent,reply.selectionStart,reply.selectionEnd]'), [draft,draft,4,4]);
  const writing = requests.find(r => r.texts.includes('我已复现'));
  assert.deepEqual(writing, {texts:['我已复现'],src:'auto',dst:'英语'});
  assert(requests.some(r => r.texts.includes(issue) && r.dst === '简体中文'));

  await p.eval("plain.focus();plain.value='前修复后';plain.setSelectionRange(1,3,'backward')");
  await click('预览翻译');
  await click('替换选区');
  assert.deepEqual(await p.eval('[plain.value,plain.selectionStart,plain.selectionEnd]'), ['前fix后',4,4]);
  await click('撤销替换');
  assert.deepEqual(await p.eval('[plain.value,plain.selectionStart,plain.selectionEnd,plain.selectionDirection]'), ['前修复后',1,3,'backward']);

  await p.eval("rich.focus(); getSelection().collapse(rich.querySelector('strong').firstChild,1)");
  const richOriginal = await p.eval('rich.innerHTML');
  await click('预览翻译');
  await until(() => p.eval(`(${message}).includes('quoted') && (${message}).includes('main()') && (${message}).includes('Thanks')`), 'preview preserves rich code and quote');
  await click('替换草稿');
  const richAfter = richOriginal.replace('谢谢', 'Thanks');
  assert.deepEqual(await p.eval('[rich.innerHTML,rich.dataset.model]'), [richAfter,richAfter]);
  await p.send('Input.dispatchKeyEvent', {type:'keyDown',key:'z',code:'KeyZ',modifiers:2,windowsVirtualKeyCode:90});
  await p.send('Input.dispatchKeyEvent', {type:'keyUp',key:'z',code:'KeyZ',modifiers:2,windowsVirtualKeyCode:90});
  assert.deepEqual(await p.eval('[rich.innerHTML,rich.dataset.model,getSelection().anchorOffset]'), [richOriginal,richOriginal,1]);

  await fillReply('慢请求');
  mode = 'slow';
  await click('预览翻译');
  await until(() => requests.some(r => r.texts.includes('慢请求')), 'request in flight');
  await insert('，补充。');
  await delay(450);
  assert.deepEqual(await p.eval(`[reply.value,model.textContent,Boolean(${buttons('替换')})]`), ['慢请求，补充。','慢请求，补充。',false]);

  for (const failure of ['fail','timeout']) {
    mode = failure;
    await fillReply('保留草稿 ' + failure);
    await click('预览翻译');
    await until(() => p.eval(`(${message}).includes('翻译失败')`), failure);
    assert.equal(await p.eval('reply.value'), '保留草稿 ' + failure);
    assert.equal(await p.eval(`Boolean(${buttons('替换')})`), false);
    mode = 'ok';
    await click('预览翻译');
    await click('替换草稿');
    assert.equal(await p.eval('model.textContent'), 'Reply');
  }

  await fillReply('');
  const beforeIme = requests.length;
  await p.send('Input.imeSetComposition', {text:'zhong',selectionStart:5,selectionEnd:5});
  assert.equal(await p.eval(`(${buttons('预览翻译')}).disabled`), true);
  await p.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',modifiers:9,windowsVirtualKeyCode:13});
  assert.equal(requests.length,beforeIme);
  await insert('中');
  assert.deepEqual(await p.eval('compositions.slice(-2)'), ['compositionstart','compositionend']);
  assert.equal(await p.eval('reply.value'), '中');
  assert.equal(await p.eval(`(${buttons('预览翻译')}).disabled`), false);
  await p.eval("pw.focus(); pw.value='fixture-only'; pw.select()");
  assert.equal(await p.eval(`Boolean(${shadow})`), false);
  console.log(JSON.stringify({ browser:(await browser.send('Browser.getVersion')).product, framework:reactDir?'React 18 controlled textarea':'DOM input binding',
    previewMs, passed:['read issue → preview → replace → undo','selection and caret','protected Markdown and rich nodes',
    'input events','editor changed in flight','HTTP failure → retry','timeout → retry','Chromium IME composition and commit','password exclusion'] }));
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
