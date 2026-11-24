/** Real extension UI; a deterministic localhost model checks request construction. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { openFixtureBrowser } from './chromium-fixture.mjs';

const documentHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Operations manual</title>
<article><h2>TCP sockets</h2><p id="tcp">The port is closed.</p>
<h2>Harbor operations</h2><p id="harbor">The port is closed.</p>
<p id="atlas">Start Atlas before deploying.</p><p id="again">Atlas handles the new deployment.</p></article></html>`;
const calls = [];
const baseline = process.argv.includes('--baseline');
const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(documentHtml);
    return;
  }
  let raw = '';
  for await (const data of request) raw += data;
  const { messages } = JSON.parse(raw);
  const prompt = messages.at(-1).content;
  const system = messages[0].content;
  const label = prompt.startsWith('Reference labels') ? JSON.parse(prompt.split('\n')[0].slice(prompt.indexOf('{'))) : {};
  const numbered = Array.from(prompt.matchAll(/^\d+\) (.*)$/gm), m => m[1]);
  const texts = numbered.length ? numbered : [prompt.split('\n\n').at(-1)];
  calls.push({ label, system, texts, chars: messages.reduce((n, m) => n + m.content.length, 0) });
  const translated = texts.map(t => {
    if (t === 'The port is closed.') return label.section === 'Harbor operations' ? '港口已关闭。' : '端口已关闭。';
    if (t.includes('Atlas')) return system.includes('Atlas = 星图系统') ? '星图系统' : '星图引擎';
    return t + '译';
  });
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    choices: [{ message: { content: numbered.length ? JSON.stringify(translated) : translated[0] } }],
  }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
async function waitFor(page, expression) {
  for (let i = 0; i < 100; i++) {
    if (await page.eval(expression)) return;
    await sleep(75);
  }
  throw new Error('Timed out: ' + expression);
}
try {
  browser = await openFixtureBrowser(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'dist');
  const base = 'chrome-extension://' + browser.extensionId;
  const options = await browser.page(base + '/options/options.html');
  await waitFor(options, '!!document.querySelector(".provider-row")');
  if (!baseline) await waitFor(options, 'document.querySelector("#glossary-service")?.textContent.includes("OpenAI")');
  await options.eval(`document.getElementById("f-baseurl").value=${JSON.stringify(origin + '/v1')};
    document.getElementById("glossary-paste").value="Atlas = 星图引擎\\nUnused = 未命中";
    document.getElementById("glossary-import").click(); document.getElementById("save").click();`);
  await waitFor(options, 'document.querySelector("#toast")?.textContent.includes("已保存")');

  const reader = await browser.page(origin);
  await waitFor(reader, '!!document.querySelector("#again")');
  // Navigate a background target to the actual popup so it resolves the reader
  // as the active tab, as it would when opened from the browser toolbar.
  const popup = await browser.page('about:blank');
  await browser.send('Target.activateTarget', { targetId: reader.targetId });
  await popup.send('Page.navigate', { url: base + '/popup/popup.html' });
  await waitFor(popup, 'document.querySelector("#info-progress")?.textContent.includes("个段落")');
  const displays = (id, word) => `document.getElementById("${id}")?.nextElementSibling?.textContent.includes("${word}")`;
  const translate = async word => {
    const start = performance.now();
    await popup.eval('document.getElementById("btn-translate").click()');
    await waitFor(reader, displays('tcp', '端口已关闭'));
    await waitFor(reader, displays('harbor', baseline ? '端口已关闭' : '港口已关闭'));
    await waitFor(reader, displays('atlas', word));
    await waitFor(reader, displays('again', word));
    return Math.round(performance.now() - start);
  };
  const firstMs = await translate('星图引擎');
  if (baseline) {
    assert(calls.every(r => !r.label.section && r.system.includes('Unused')));
  } else {
    assert(calls.every(r => r.label.title === 'Operations manual' && !r.system.includes('Unused')));
    assert(calls.some(r => r.label.section === 'Harbor operations' && r.system.includes('Atlas = 星图引擎')));
  }
  const initialCalls = calls.length;
  await options.eval(`const target = document.querySelector('.glossary-row input[placeholder="译文"]');
    target.value='星图系统'; target.dispatchEvent(new Event('input')); target.dispatchEvent(new Event('change'));
    document.getElementById('save').click();`);
  await waitFor(options, '!document.getElementById("save").disabled && !document.getElementById("save-hint").textContent');
  await popup.eval('document.getElementById("btn-restore").click()');
  await waitFor(reader, '!document.querySelector(".wt-bilingual-block")');
  const revisedMs = await translate('星图系统');
  assert(calls.slice(initialCalls).some(r => r.system.includes('Atlas = 星图系统')));
  console.log(JSON.stringify({ browser: (await browser.send('Browser.getVersion')).product, initialCalls,
    revisedCalls: calls.length - initialCalls, chars: calls.reduce((n, r) => n + r.chars, 0),
    firstMs, revisedMs, checkedParagraphs: 4 }));
} finally {
  try { await browser?.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
