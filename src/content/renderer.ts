/**
 * DOM rendering layer (spec §7.1 / §7.5).
 *
 * The renderer is the only module that mutates original page nodes. It always
 * saves the original child nodes before replacing content, so the original
 * text is fully restorable (spec §7.1 rule 5).
 *
 * 2.0: content.css does not reach into shadow roots, so every modified
 * shadow root receives a style clone (spec 2.0 §6.1 item 2).
 *
 * 4.0: nav / [role=navigation] labels keep their original markup (so links
 * stay clickable) and get a compact `原文[译文]` suffix instead of a stacked
 * bilingual block.
 */
import {
  BILINGUAL_CLASS,
  DATA_ATTR,
  ERROR_CLASS,
  NAV_TRANSLATION_CLASS,
  PENDING_CLASS,
  SHADOW_STYLE_ATTR,
} from '../shared/constants';
import type { DisplayMode } from '../shared/types';
import contentCss from '../styles/content.css?raw';
import type { NodeEntry } from './translator';
import { isMenuChrome } from './scanner';

/** Elements where inserting a sibling block would produce invalid HTML
 *  (table rows, lists); for those the translation block goes inside. */
const INSERT_INSIDE_TAGS = new Set(['TD', 'TH', 'LI', 'DT', 'DD', 'FIGCAPTION']);

/** Inject our stylesheet into a shadow root once (spec 2.0 §6.1). */
export function ensureShadowStyle(root: ShadowRoot): void {
  if (root.querySelector(`style[${SHADOW_STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(SHADOW_STYLE_ATTR, '1');
  style.textContent = contentCss;
  root.prepend(style);
}

/** Ensure styles exist in whichever root the element lives in. */
export function ensureStylesFor(el: Element): void {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) ensureShadowStyle(root);
}

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

/** Prefer the single child link so `Contents[目录]` stays on the same line. */
export function menuLabelHost(el: HTMLElement): HTMLElement {
  const links = Array.from(el.children).filter((child) => child.tagName === 'A');
  if (links.length === 1) return links[0] as HTMLElement;
  return el;
}

function menuSuffixText(entry: NodeEntry): string | null {
  if (entry.status === 'pending') return '[翻译中…]';
  if (entry.status === 'done' && entry.translated !== null) return `[${entry.translated}]`;
  if (entry.status === 'error') return `[翻译失败]`;
  return null;
}

function updateMenuSuffix(entry: NodeEntry): void {
  const text = menuSuffixText(entry);
  if (text === null) {
    removeMenuSuffix(entry);
    return;
  }
  let suffix = entry.bilingualEl;
  if (!suffix || !suffix.isConnected) {
    suffix = document.createElement('span');
    suffix.className = NAV_TRANSLATION_CLASS;
    suffix.setAttribute(DATA_ATTR, entry.id);
    entry.bilingualEl = suffix;
    menuLabelHost(entry.el).appendChild(suffix);
    ensureStylesFor(suffix);
  }
  suffix.classList.toggle('wt-nav-pending', entry.status === 'pending');
  suffix.classList.toggle('wt-nav-error', entry.status === 'error');
  suffix.textContent = text;
}

export function removeMenuSuffix(entry: NodeEntry): void {
  if (entry.bilingualEl) {
    entry.bilingualEl.remove();
    entry.bilingualEl = null;
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
    ensureStylesFor(block);
  }
  block.classList.remove('wt-bilingual-pending', 'wt-bilingual-error');
  if (entry.status === 'pending') {
    block.textContent = '翻译中…';
    block.classList.add('wt-bilingual-pending');
  } else if (entry.status === 'done' && entry.translated !== null) {
    block.textContent = entry.translated;
  } else if (entry.status === 'error') {
    block.textContent = `翻译失败：${entry.error ?? '未知错误'}（点击重试）`;
    block.classList.add('wt-bilingual-error');
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

function renderMenuEntry(entry: NodeEntry, mode: DisplayMode | null): void {
  restoreOriginal(entry);
  const show = mode !== null && mode !== 'original';
  if (show) updateMenuSuffix(entry);
  else removeMenuSuffix(entry);
}

/**
 * Render one entry for the given mode. `mode === null` means "untouched
 * original page" (restores everything and removes inserted blocks).
 * Inline mode is driven by the translator (per-segment spans); here a
 * degraded inline entry falls back to paragraph-level bilingual.
 */
export function renderEntry(entry: NodeEntry, mode: DisplayMode | null): void {
  const effective: DisplayMode | null =
    mode === 'inline' && entry.inlineDegraded ? 'bilingual' : mode;

  if (isMenuChrome(entry.el)) {
    renderMenuEntry(entry, effective === 'inline' ? 'bilingual' : effective);
    return;
  }

  if (effective === 'inline') {
    // Body keeps the original text; segment spans are managed by translator.
    restoreOriginal(entry);
    removeBilingualBlock(entry);
    return;
  }

  const bodyShowsTranslation =
    effective === 'translated' || effective === 'translated_hover_original';
  const showBlock = effective === 'bilingual';

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
