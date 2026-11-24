interface ExportPage {
  scanned: boolean;
  loaded: boolean;
  paragraphs: Array<{ text: string; translated: string | null }>;
}

const escapeText = (s: string): string => s.replace(/[&<>]/g, (c) =>
  c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');

/** Export the current reading snapshot without starting translation or OCR. */
export function bilingualPdfHtml(
  title: string, first: number, last: number, getPage: (number: number) => ExportPage | undefined,
): string {
  const sections: string[] = [];
  for (let number = first; number <= last; number++) {
    const page = getPage(number);
    const content = !page?.loaded ? '<p>未读取</p>' : page.scanned ? '<p>扫描页，尚未识别</p>' :
      page.paragraphs.map((p) =>
        `<article><p>${escapeText(p.text)}</p><p class="translation">${escapeText(p.translated ?? '尚未翻译')}</p></article>`,
      ).join('\n');
    sections.push(`<section><h2>第 ${number} 页</h2>${content}</section>`);
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeText(title)} · 双语阅读</title>
<style>body{font:16px/1.65 system-ui,sans-serif;margin:2rem auto;max-width:52rem;padding:0 1rem}article{break-inside:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}.translation{border-left:3px solid #5373bb;padding-left:.8rem}section{border-top:1px solid #ccc}</style>
<h1>${escapeText(title)}</h1><p>双语阅读记录 · 第 ${first} 至 ${last} 页</p>${sections.join('\n')}</html>`;
}
