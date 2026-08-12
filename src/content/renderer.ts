/**
 * DOM rendering layer (spec §7.1 / §7.5).
 *
 * The renderer is the only module that mutates original page nodes. It always
 * saves the original child nodes before replacing content, so the original
 * text is fully restorable (spec §7.1 rule 5).
 */
import { BILINGUAL_CLASS, DATA_ATTR, ERROR_CLASS, PENDING_CLASS } from '../shared/constants';
import type { DisplayMode } from '../shared/types';
import type { NodeEntry } from './translator';

/** Elements where inserting a sibling block would produce invalid HTML
 *  (table rows, lists); for those the translation block goes inside. */
const INSERT_INSIDE_TAGS = new Set(['TD', 'TH', 'LI', 'DT', 'DD', 'FIGCAPTION']);

export function saveOriginal(entry: NodeEntry): void {
  if (entry.originalNodes === null) {
    entry.originalNodes = Array.from(entry.el.childNodes);
  }
}

/** Restore the element's original content. */
export function restoreOriginal(entry: NodeEntry): void {
  if (entry.originalNodes !== null) {
    entry.el.replaceChildren(...entry.originalNodes);
    entry.originalNodes = null;
  }
  entry.el.classList.remove(PENDING_CLASS, ERROR_CLASS);
}

/** Replace element content with the translation (or original while pending). */
export function showTranslated(entry: NodeEntry): void {
  saveOriginal(entry);
  const useTranslation = entry.status === 'done' && entry.translated !== null;
  entry.el.textContent = useTranslation ? entry.translated : entry.originalText;
  entry.el.classList.toggle(PENDING_CLASS, entry.status === 'pending');
  entry.el.classList.toggle(ERROR_CLASS, entry.status === 'error');
}

function insertBlock(el: HTMLElement, block: HTMLElement): void {
  if (INSERT_INSIDE_TAGS.has(el.tagName)) {
    el.appendChild(block);
  } else {
    el.insertAdjacentElement('afterend', block);
  }
}

/** Create/update the bilingual block for an entry (spec §7.5). */
export function updateBilingualBlock(entry: NodeEntry): void {
  let block = entry.bilingualEl;
  if (!block) {
    block = document.createElement('div');
    block.className = BILINGUAL_CLASS;
    block.setAttribute(DATA_ATTR, entry.id);
    entry.bilingualEl = block;
    insertBlock(entry.el, block);
  }
  block.classList.remove('wt-bilingual-pending', 'wt-bilingual-error');
  if (entry.status === 'pending') {
    block.textContent = '翻译中…';
    block.classList.add('wt-bilingual-pending');
  } else if (entry.status === 'error') {
    block.textContent = `⚠ 翻译失败：${entry.error ?? '未知错误'}（点击重试）`;
    block.classList.add('wt-bilingual-error');
  } else if (entry.status === 'done' && entry.translated !== null) {
    block.textContent = entry.translated;
  } else {
    block.textContent = '待翻译';
    block.classList.add('wt-bilingual-pending');
  }
}

export function removeBilingualBlock(entry: NodeEntry): void {
  if (entry.bilingualEl) {
    entry.bilingualEl.remove();
    entry.bilingualEl = null;
  }
}

/**
 * Render one entry for the given mode. `mode === null` means "untouched
 * original page" (restores everything and removes inserted blocks).
 */
export function renderEntry(entry: NodeEntry, mode: DisplayMode | null): void {
  const bodyShowsTranslation = mode === 'translated' || mode === 'translated_hover_original';
  const showBlock = mode === 'bilingual';

  if (bodyShowsTranslation) {
    showTranslated(entry);
  } else {
    restoreOriginal(entry);
  }

  if (showBlock) {
    updateBilingualBlock(entry);
  } else {
    removeBilingualBlock(entry);
  }
}
