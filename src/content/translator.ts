/**
 * Page translation orchestrator (spec §9, §10.2).
 *
 * Maintains the original<->translated mapping for every scanned node, talks
 * to the background service worker for translations (never calls APIs
 * directly, never sees API keys), and drives rendering + tooltips.
 */
import { sendRuntime } from '../messaging/messages';
import { BILINGUAL_CLASS, DATA_ATTR } from '../shared/constants';
import type { DisplayMode, NodeStatus, PageState, TranslationItem } from '../shared/types';
import { renderEntry } from './renderer';
import { scanTranslatableNodes } from './scanner';
import { Tooltip } from './tooltip';

export interface NodeEntry {
  id: string;
  el: HTMLElement;
  originalText: string;
  /** Saved original child nodes while content is replaced; null = untouched. */
  originalNodes: ChildNode[] | null;
  translated: string | null;
  status: NodeStatus;
  error: string | null;
  bilingualEl: HTMLElement | null;
}

/** Items per runtime message: small enough for progressive updates. */
const CHUNK_SIZE = 8;

export class PageTranslator {
  private entries = new Map<string, NodeEntry>();
  private counter = 0;
  private _mode: DisplayMode | null = null;
  private _active = false;
  private tooltip = new Tooltip();

  /** Set by the bootstrap when the host is on the blacklist. */
  blacklisted = false;
  minTextLength = 6;
  lastError: string | null = null;

  get active(): boolean {
    return this._active;
  }

  get mode(): DisplayMode | null {
    return this._mode;
  }

  /* --------------------------------- scanning -------------------------------- */

  /** Scan the page and register new candidate nodes. Returns #added. */
  scan(): number {
    if (!document.body) return 0;
    const elements = scanTranslatableNodes(document.body, this.minTextLength);
    let added = 0;
    for (const el of elements) {
      const existingId = el.getAttribute(DATA_ATTR);
      if (existingId && this.entries.has(existingId)) continue;
      const id = existingId ?? `wt-${++this.counter}`;
      if (!existingId) el.setAttribute(DATA_ATTR, id);
      this.entries.set(id, {
        id,
        el,
        originalText: (el.textContent ?? '').trim(),
        originalNodes: null,
        translated: null,
        status: 'idle',
        error: null,
        bilingualEl: null,
      });
      added++;
    }
    return added;
  }

  /* ------------------------------ public actions ----------------------------- */

  async translate(mode: DisplayMode): Promise<void> {
    if (this.blacklisted) return;
    this._active = true;
    this._mode = mode;
    this.scan();
    this.renderAll();
    const missing = this.entriesWithStatus(['idle', 'error']);
    if (missing.length > 0) await this.fetchTranslations(missing);
  }

  async setMode(mode: DisplayMode): Promise<void> {
    if (!this._active) {
      await this.translate(mode);
      return;
    }
    if (mode === 'original') {
      this.restore();
      return;
    }
    this._mode = mode;
    this.renderAll();
    const missing = this.entriesWithStatus(['idle']);
    if (missing.length > 0) await this.fetchTranslations(missing);
  }

  restore(): void {
    this._active = false;
    this._mode = null;
    this.tooltip.hideNow();
    this.renderAll();
  }

  async retryFailed(): Promise<void> {
    const failed = this.entriesWithStatus(['error']);
    if (failed.length > 0) {
      this.lastError = null;
      await this.fetchTranslations(failed);
    }
  }

  rescan(): void {
    this.scan();
    if (this._active) {
      this.renderAll();
      const idle = this.entriesWithStatus(['idle']);
      if (idle.length > 0) void this.fetchTranslations(idle);
    }
  }

  state(): PageState {
    let translated = 0;
    let pending = 0;
    let failed = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === 'done') translated++;
      else if (entry.status === 'pending') pending++;
      else if (entry.status === 'error') failed++;
    }
    return {
      injected: true,
      blacklisted: this.blacklisted,
      active: this._active,
      mode: this._mode,
      total: this.entries.size,
      translated,
      pending,
      failed,
      lastError: this.lastError,
    };
  }

  /* ------------------------------- translation -------------------------------- */

  private entriesWithStatus(statuses: NodeStatus[]): NodeEntry[] {
    const wanted = new Set(statuses);
    return [...this.entries.values()].filter((e) => wanted.has(e.status));
  }

  private async fetchTranslations(targets: NodeEntry[]): Promise<void> {
    for (const entry of targets) {
      entry.status = 'pending';
      entry.error = null;
    }
    this.renderAll();

    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
      const chunk = targets.slice(i, i + CHUNK_SIZE);
      const items: TranslationItem[] = chunk.map((e) => ({ key: e.id, text: e.originalText }));
      try {
        const response = await sendRuntime({ type: 'translate', items });
        for (const entry of chunk) {
          const text = response.results[entry.id];
          if (text !== undefined) {
            entry.translated = text;
            entry.status = 'done';
          } else {
            const err = response.errors[entry.id];
            entry.status = 'error';
            entry.error = err?.message ?? '翻译失败';
            this.lastError = entry.error;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const entry of chunk) {
          entry.status = 'error';
          entry.error = message;
        }
        this.lastError = message;
      }
      this.renderAll();
      this.refreshTooltipForChunk(chunk);
    }
  }

  private refreshTooltipForChunk(chunk: NodeEntry[]): void {
    const current = this.tooltip.currentTarget;
    if (!current) return;
    const entry = chunk.find((e) => e.el === current);
    if (!entry) return;
    if (entry.status === 'done' && entry.translated !== null) {
      this.tooltip.show(entry.el, entry.translated, 'ready');
    } else if (entry.status === 'error') {
      this.tooltip.show(entry.el, entry.error ?? '翻译失败', 'error');
    }
  }

  /* --------------------------------- rendering -------------------------------- */

  private renderAll(): void {
    for (const [id, entry] of this.entries) {
      if (!entry.el.isConnected) {
        entry.bilingualEl = null;
        this.entries.delete(id);
        continue;
      }
      renderEntry(entry, this._mode);
    }
  }

  /* ------------------------------ hover & clicks ------------------------------ */

  init(): void {
    document.addEventListener('mouseover', this.onMouseOver);
    document.addEventListener('mouseout', this.onMouseOut);
    document.addEventListener('click', this.onClick);
  }

  private hoverModeActive(): boolean {
    return (
      this._active &&
      (this._mode === 'translated_hover_original' || this._mode === 'original_hover_translated')
    );
  }

  private findEntry(target: EventTarget | null): NodeEntry | null {
    if (!(target instanceof Element)) return null;
    const el = target.closest(`[${DATA_ATTR}]`);
    if (!el || el.classList.contains(BILINGUAL_CLASS)) return null;
    const id = el.getAttribute(DATA_ATTR);
    return id ? (this.entries.get(id) ?? null) : null;
  }

  private onMouseOver = (e: MouseEvent): void => {
    if (!this.hoverModeActive()) return;
    const entry = this.findEntry(e.target);
    if (!entry) return;

    if (this._mode === 'translated_hover_original') {
      this.tooltip.show(entry.el, entry.originalText, 'ready');
      return;
    }
    // original_hover_translated
    if (entry.status === 'done' && entry.translated !== null) {
      this.tooltip.show(entry.el, entry.translated, 'ready');
    } else if (entry.status === 'pending') {
      this.tooltip.show(entry.el, '', 'loading');
    } else if (entry.status === 'error') {
      this.tooltip.show(entry.el, entry.error ?? '翻译失败', 'error');
    } else {
      // Not translated yet — translate on demand while showing "translating".
      this.tooltip.show(entry.el, '', 'loading');
      void this.fetchTranslations([entry]);
    }
  };

  private onMouseOut = (e: MouseEvent): void => {
    if (!this.hoverModeActive()) return;
    const from = this.findEntry(e.target);
    const to = this.findEntry(e.relatedTarget);
    if (from && from === to) return; // still inside the same entry
    this.tooltip.hide();
  };

  /** Click-to-retry on failed bilingual blocks. */
  private onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target.closest('.wt-bilingual-error') : null;
    if (!target) return;
    const id = target.getAttribute(DATA_ATTR);
    const entry = id ? this.entries.get(id) : null;
    if (entry) void this.fetchTranslations([entry]);
  };
}
