/**
 * Page translation orchestrator (spec §9, §10.2), evolved for 2.0.
 *
 * Maintains the original<->translated mapping for every scanned node, talks
 * to the background service worker for translations (never calls APIs
 * directly, never sees API keys), and drives rendering + tooltips.
 *
 * 2.0 additions:
 *  - inline display mode (spec 2.0 §7.2) with budget/degrade;
 *  - viewport-only translation for virtual lists (spec 2.0 §6.3);
 *  - site-rule aware scanning (spec 2.0 §6.4);
 *  - shadow-DOM aware scanning (spec 2.0 §6.1);
 *  - streaming on-demand single entry translation (spec 2.0 §7.3);
 *  - recycled-node re-translation for virtual scrolling;
 *  - frame state reporting + bilingual export collection.
 */
import { sendRuntime } from '../messaging/messages';
import { STREAM_PORT_NAME } from '../messaging/messages';
import type { StreamPortInit, StreamPortMessage } from '../messaging/messages';
import { BILINGUAL_CLASS, DATA_ATTR } from '../shared/constants';
import type {
  DisplayMode,
  EffectiveRule,
  NodeStatus,
  PageState,
  TranslationItem,
} from '../shared/types';
import { hashText } from '../shared/utils';
import type { ExportEntry } from '../messaging/messages';
import { allocateInlineBudget, collectInlineSegments, renderInlineSegment } from './inline';
import { ensureStylesFor, renderEntry } from './renderer';
import { scanTranslatableNodesWithRule } from './scanner';
import { Tooltip } from './tooltip';

export interface InlineSegmentState {
  key: string;
  text: string;
  dstEl: HTMLElement | null;
  status: NodeStatus;
  translated: string | null;
  error: string | null;
}

export interface NodeEntry {
  id: string;
  el: HTMLElement;
  originalText: string;
  /** Hash of originalText, used for recycle detection (spec 2.0 §6.3). */
  textHash: string;
  /** Saved original child nodes while content is replaced; null = untouched. */
  originalNodes: ChildNode[] | null;
  translated: string | null;
  status: NodeStatus;
  error: string | null;
  bilingualEl: HTMLElement | null;
  /** inline mode segments; null = not segmented. */
  inlineSegments: InlineSegmentState[] | null;
  /** inline mode over budget -> paragraph-level bilingual fallback. */
  inlineDegraded: boolean;
  /** viewport gating (spec 2.0 §6.3). */
  visible: boolean;
}

/** Items per runtime message: small enough for progressive updates. */
const CHUNK_SIZE = 8;

export interface TranslatorConfig {
  minTextLength: number;
  rule: EffectiveRule | null;
  inlineBudget: number;
  viewportBudget: number;
  streamingAvailable: boolean;
  /** 3.0: detected page language, forwarded to the background so providers
   *  with sourceLanguage=auto can receive it (spec 3.0 §8.1 item 2). */
  pageLanguage: string | null;
}

export class PageTranslator {
  private entries = new Map<string, NodeEntry>();
  private counter = 0;
  private _mode: DisplayMode | null = null;
  private _active = false;
  private tooltip = new Tooltip();
  private io: IntersectionObserver | null = null;
  private _viewportActive = false;
  private _inlineDowngraded = false;
  private config: TranslatorConfig = {
    minTextLength: 6,
    rule: null,
    inlineBudget: 300,
    viewportBudget: 500,
    streamingAvailable: false,
    pageLanguage: null,
  };

  /** Set by the bootstrap when the host is on the blacklist. */
  blacklisted = false;
  lastError: string | null = null;
  /** Provider name that actually served translations after failover. */
  actualProvider: string | null = null;
  /** Called whenever the page state changed (frame reporting). */
  onStateChange: ((state: PageState) => void) | null = null;

  get active(): boolean {
    return this._active;
  }

  get mode(): DisplayMode | null {
    return this._mode;
  }

  get minTextLength(): number {
    return this.config.minTextLength;
  }

  set minTextLength(value: number) {
    this.config.minTextLength = value;
  }

  configure(partial: Partial<TranslatorConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /* --------------------------------- scanning -------------------------------- */

  /** Scan the page and register new candidate nodes. Returns #added. */
  scan(): number {
    if (!document.body) return 0;
    const elements = scanTranslatableNodesWithRule(document.body, {
      minTextLength: this.config.minTextLength,
      rule: this.config.rule,
    });
    let added = 0;
    for (const el of elements) {
      const existingId = el.getAttribute(DATA_ATTR);
      if (existingId && this.entries.has(existingId)) continue;
      const id = existingId ?? `wt-${++this.counter}`;
      if (!existingId) el.setAttribute(DATA_ATTR, id);
      const text = (el.textContent ?? '').trim();
      this.entries.set(id, {
        id,
        el,
        originalText: text,
        textHash: hashText(text),
        originalNodes: null,
        translated: null,
        status: 'idle',
        error: null,
        bilingualEl: null,
        inlineSegments: null,
        inlineDegraded: false,
        visible: !this._viewportActive,
      });
      added++;
    }
    if (this._viewportActive && added > 0) this.observeNewEntries();
    this.applyViewportBudget();
    return added;
  }

  /** Auto-degrade to viewport-only when pending items exceed the budget. */
  private applyViewportBudget(): void {
    if (this._viewportActive) return;
    const pendingCount = [...this.entries.values()].filter(
      (e) => e.status === 'idle' || e.status === 'pending',
    ).length;
    if (pendingCount > this.config.viewportBudget) {
      this._viewportActive = true;
      for (const entry of this.entries.values()) entry.visible = false;
      this.observeNewEntries();
    }
  }

  private observeNewEntries(): void {
    if (!this._viewportActive) return;
    if (!this.io) {
      this.io = new IntersectionObserver(
        (records) => {
          const newlyVisible: NodeEntry[] = [];
          for (const rec of records) {
            const entry = this.findEntryByEl(rec.target);
            if (!entry) continue;
            if (rec.isIntersecting && !entry.visible) {
              entry.visible = true;
              newlyVisible.push(entry);
            }
          }
          if (newlyVisible.length > 0 && this._active) {
            const work = newlyVisible.filter((e) => e.status === 'idle' || e.status === 'error');
            if (work.length > 0) void this.fetchTranslations(work);
          }
        },
        { rootMargin: '300px' },
      );
    }
    for (const entry of this.entries.values()) {
      if (!entry.visible && entry.el.isConnected) this.io.observe(entry.el);
    }
  }

  private findEntryByEl(el: Element): NodeEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.el === el) return entry;
    }
    return null;
  }

  /* ------------------------------ public actions ----------------------------- */

  async translate(mode: DisplayMode): Promise<void> {
    if (this.blacklisted) return;
    this._active = true;
    this._mode = mode;
    // Site rule can force viewport-only translation (virtual lists).
    if (this.config.rule?.viewportOnly && !this._viewportActive) {
      this._viewportActive = true;
      for (const entry of this.entries.values()) entry.visible = false;
    }
    this.scan();
    if (mode === 'inline') {
      await this.translateInline();
      return;
    }
    this.renderAll();
    const missing = this.gateViewport(this.entriesWithStatus(['idle', 'error']));
    if (missing.length > 0) await this.fetchTranslations(missing);
    this.report();
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
    const previous = this._mode;
    // Mode switches abort unfinished batches (spec 2.0 §5.3 item 5); pending
    // entries become idle again and are re-fetched below.
    this.cancelInflight();
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending') {
        entry.status = 'idle';
        entry.error = null;
      }
      if (entry.inlineSegments) {
        for (const seg of entry.inlineSegments) {
          if (seg.status === 'pending') seg.status = 'idle';
        }
      }
    }
    this._mode = mode;
    if (mode === 'inline') {
      await this.translateInline();
      return;
    }
    // Leaving inline mode: restore entry bodies first.
    if (previous === 'inline') {
      for (const entry of this.entries.values()) {
        if (entry.inlineSegments) {
          entry.inlineSegments = null;
          entry.inlineDegraded = false;
        }
      }
      this._inlineDowngraded = false;
    }
    this.renderAll();
    const missing = this.gateViewport(this.entriesWithStatus(['idle']));
    if (missing.length > 0) await this.fetchTranslations(missing);
    this.report();
  }

  restore(): void {
    this._active = false;
    this._mode = null;
    this._inlineDowngraded = false;
    this.tooltip.hideNow();
    this.cancelInflight();
    for (const entry of this.entries.values()) {
      entry.inlineSegments = null;
      entry.inlineDegraded = false;
      if (entry.status === 'pending') {
        entry.status = 'idle';
        entry.error = null;
      }
    }
    this.renderAll();
    this.report();
  }

  /**
   * Ask the background to abort this tab's unfinished translation batches
   * (spec 2.0 §5.3 item 5). The native-host provider turns the abort into a
   * gateway `cancel`; HTTP providers abort the fetch.
   */
  private cancelInflight(): void {
    const hasPending = [...this.entries.values()].some(
      (e) =>
        e.status === 'pending' ||
        (e.inlineSegments ?? []).some((s) => s.status === 'pending'),
    );
    if (!hasPending) return;
    sendRuntime({ type: 'cancel-translations' }).catch(() => {
      /* background may be restarting; requests time out on their own */
    });
  }

  async retryFailed(): Promise<void> {
    const failed = this.entriesWithStatus(['error']);
    if (failed.length > 0) {
      this.lastError = null;
      await this.fetchTranslations(failed);
      this.report();
    }
  }

  /**
   * 3.0 resume (spec 3.0 §8.4): the background persisted these task keys as
   * in-flight before a service-worker restart. Re-submit them; completed
   * items are skipped by the cache (idempotent).
   */
  async resumeInflight(keys: string[]): Promise<void> {
    const wanted = new Set(keys);
    const targets: NodeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!wanted.has(entry.id)) continue;
      if (entry.status === 'done') continue; // cache idempotency
      entry.status = 'idle';
      entry.error = null;
      targets.push(entry);
    }
    if (targets.length === 0) return;
    if (!this._active) {
      this._active = true;
      this._mode = this._mode ?? 'bilingual';
    }
    await this.fetchTranslations(targets);
    this.report();
  }

  rescan(): void {
    this.scan();
    if (this._active) {
      if (this._mode === 'inline') {
        void this.translateInline();
        return;
      }
      this.renderAll();
      const idle = this.gateViewport(this.entriesWithStatus(['idle']));
      if (idle.length > 0) void this.fetchTranslations(idle);
      this.report();
    }
  }

  state(): PageState {
    let translated = 0;
    let pending = 0;
    let failed = 0;
    for (const entry of this.entries.values()) {
      const status = this.effectiveStatus(entry);
      if (status === 'done') translated++;
      else if (status === 'pending') pending++;
      else if (status === 'error') failed++;
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
      isTopFrame: window.self === window.top,
      frameUrl: location.href,
      actualProvider: this.actualProvider,
      inlineDowngraded: this._inlineDowngraded,
      viewportOnly: this._viewportActive,
    };
  }

  /** Bilingual export payload (spec 2.0 §7.5). */
  collectExport(): { entries: ExportEntry[]; title: string } {
    const entries: ExportEntry[] = [];
    for (const entry of this.entries.values()) {
      entries.push({
        original: entry.originalText,
        translated: entry.status === 'done' ? entry.translated : null,
        status: entry.status,
        tag: entry.el.tagName.toLowerCase(),
      });
    }
    return { entries, title: document.title };
  }

  /* ------------------------------- inline mode -------------------------------- */

  private async translateInline(): Promise<void> {
    this._mode = 'inline';

    // Phase 1: compute segments for entries not yet segmented.
    const pendingEntries: { entry: NodeEntry; segments: ReturnType<typeof collectInlineSegments> }[] = [];
    for (const entry of this.entries.values()) {
      if (entry.inlineSegments || entry.inlineDegraded) continue;
      pendingEntries.push({ entry, segments: collectInlineSegments(entry.el, entry.id) });
    }

    // Phase 2: allocate the page inline budget (spec 2.0 §7.2 item 3).
    const plan = allocateInlineBudget(
      pendingEntries.map((p) => p.segments.length),
      this.config.inlineBudget,
    );
    if (plan.downgraded) this._inlineDowngraded = true;

    pendingEntries.forEach(({ entry, segments }, index) => {
      if (!plan.accepted[index]) {
        entry.inlineDegraded = true;
        return;
      }
      // Deep clone: inline rendering mutates text nodes INSIDE nested inline
      // elements (strong/a/...), so shallow node references would restore
      // mutated content. Clones keep the pristine original tree.
      entry.originalNodes =
        entry.originalNodes ?? Array.from(entry.el.childNodes, (n) => n.cloneNode(true) as ChildNode);
      entry.inlineSegments = segments.map((s) => ({
        key: s.key,
        text: s.text,
        dstEl: null,
        status: 'idle' as NodeStatus,
        translated: null,
        error: null,
      }));
      // Render the segment structure now (original markup preserved).
      ensureStylesFor(entry.el);
      segments.forEach((segment, i) => {
        const rendered = renderInlineSegment(segment);
        entry.inlineSegments![i].dstEl = rendered.dstEl;
      });
    });

    this.renderAll();

    // Tasks: idle segments + degraded entries (paragraph-level).
    const segmentTasks: { entry: NodeEntry; segment: InlineSegmentState }[] = [];
    const degraded: NodeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.inlineSegments) {
        for (const seg of entry.inlineSegments) {
          if (seg.status === 'idle' || seg.status === 'error') {
            segmentTasks.push({ entry, segment: seg });
          }
        }
      } else if (entry.inlineDegraded && (entry.status === 'idle' || entry.status === 'error')) {
        degraded.push(entry);
      }
    }

    for (const entry of degraded) {
      entry.status = 'pending';
      entry.error = null;
    }
    for (const task of segmentTasks) task.segment.status = 'pending';
    this.renderAll();

    if (degraded.length > 0) await this.fetchTranslations(degraded);
    if (segmentTasks.length > 0) await this.fetchSegmentTranslations(segmentTasks);
    this.report();
  }

  private async fetchSegmentTranslations(
    tasks: { entry: NodeEntry; segment: InlineSegmentState }[],
  ): Promise<void> {
    for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
      const chunk = tasks.slice(i, i + CHUNK_SIZE);
      const items: TranslationItem[] = chunk.map((t) => ({ key: t.segment.key, text: t.segment.text }));
      try {
        const response = await sendRuntime({
          type: 'translate',
          items,
          domain: location.hostname,
          pageLanguage: this.config.pageLanguage,
        });
        if (!this._active) return;
        if (response.actualProviderName) this.actualProvider = response.actualProviderName;
        for (const task of chunk) {
          const text = response.results[task.segment.key];
          if (text !== undefined) {
            task.segment.translated = text;
            task.segment.status = 'done';
          } else {
            const err = response.errors[task.segment.key];
            task.segment.status = 'error';
            task.segment.error = err?.message ?? '翻译失败';
            this.lastError = task.segment.error;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const task of chunk) {
          task.segment.status = 'error';
          task.segment.error = message;
        }
        this.lastError = message;
      }
      if (!this._active) return;
      this.renderAll();
    }
  }

  /* ------------------------------- translation -------------------------------- */

  private entriesWithStatus(statuses: NodeStatus[]): NodeEntry[] {
    const wanted = new Set(statuses);
    return [...this.entries.values()].filter((e) => wanted.has(this.effectiveStatus(e)));
  }

  /** Entry status aggregated from inline segments when present. */
  private effectiveStatus(entry: NodeEntry): NodeStatus {
    if (!entry.inlineSegments) return entry.status;
    let pending = 0;
    let error = 0;
    let done = 0;
    for (const seg of entry.inlineSegments) {
      if (seg.status === 'pending' || seg.status === 'idle') pending++;
      else if (seg.status === 'error') error++;
      else done++;
    }
    if (pending > 0) return entry.inlineSegments.every((s) => s.status === 'idle') ? 'idle' : 'pending';
    if (error > 0) return 'error';
    return done > 0 ? 'done' : 'idle';
  }

  private gateViewport(entries: NodeEntry[]): NodeEntry[] {
    if (!this._viewportActive) return entries;
    return entries.filter((e) => e.visible);
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
        const response = await sendRuntime({
          type: 'translate',
          items,
          domain: location.hostname,
          pageLanguage: this.config.pageLanguage,
        });
        if (!this._active) return;
        if (response.actualProviderName) this.actualProvider = response.actualProviderName;
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
      // The page may have been restored (batches cancelled) while awaiting;
      // never apply stale results to an inactive page.
      if (!this._active) return;
      this.renderAll();
      this.refreshTooltipForChunk(chunk);
      this.report();
    }
  }

  /** Streaming single-entry translation (spec 2.0 §7.3, on-demand hover). */
  translateEntryStreaming(entry: NodeEntry): void {
    entry.status = 'pending';
    entry.error = null;
    this.renderAll();
    this.report();
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    } catch (e) {
      entry.status = 'error';
      entry.error = e instanceof Error ? e.message : String(e);
      this.renderAll();
      return;
    }
    let accumulated = '';
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as StreamPortMessage;
      if (msg.type === 'finished') {
        try {
          port.disconnect();
        } catch {
          /* already closed */
        }
        return;
      }
      if (msg.key !== entry.id) return;
      if (msg.type === 'delta') {
        accumulated += msg.delta;
        if (this.tooltip.currentTarget === entry.el) {
          this.tooltip.show(entry.el, accumulated, 'ready');
        }
      } else if (msg.type === 'done') {
        entry.translated = msg.text;
        entry.status = 'done';
        this.renderAll();
        this.refreshTooltipForChunk([entry]);
        this.report();
        port.disconnect();
      } else if (msg.type === 'error') {
        entry.status = 'error';
        entry.error = msg.message;
        this.lastError = msg.message;
        this.renderAll();
        this.report();
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (entry.status === 'pending') {
        entry.status = 'error';
        entry.error = '流式连接中断';
        this.renderAll();
        this.report();
      }
    });
    const init: StreamPortInit = {
      items: [{ key: entry.id, text: entry.originalText }],
      domain: location.hostname,
    };
    port.postMessage(init);
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

  /* ------------------------- recycled nodes (virtual lists) ------------------- */

  /**
   * Detect entries whose element text changed under us (virtual scroll
   * recycling) and reset them for re-translation (spec 2.0 §6.3).
   * Returns true when anything changed.
   */
  detectRecycledNodes(): boolean {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (!entry.el.isConnected) continue;
      const current = (entry.el.textContent ?? '').trim();
      if (current === '' || current === this.expectedText(entry)) continue;
      // The page replaced this node's content: drop stale mappings.
      entry.originalNodes = null;
      entry.inlineSegments = null;
      entry.inlineDegraded = false;
      entry.bilingualEl = null;
      entry.translated = null;
      entry.error = null;
      entry.status = 'idle';
      entry.originalText = current;
      entry.textHash = hashText(current);
      changed = true;
    }
    if (changed && this._active) {
      if (this._mode === 'inline') {
        void this.translateInline();
      } else {
        const idle = this.gateViewport(this.entriesWithStatus(['idle']));
        if (idle.length > 0) void this.fetchTranslations(idle);
        this.renderAll();
      }
      this.report();
    }
    return changed;
  }

  private expectedText(entry: NodeEntry): string {
    if (!this._active || this._mode === null || this._mode === 'original') {
      return entry.originalText;
    }
    if (this._mode === 'translated' || this._mode === 'translated_hover_original') {
      return entry.status === 'done' && entry.translated !== null
        ? entry.translated
        : entry.originalText;
    }
    // bilingual / hover / inline keep the original visible.
    return entry.originalText;
  }

  /* --------------------------------- rendering -------------------------------- */

  private renderAll(): void {
    for (const [id, entry] of this.entries) {
      if (!entry.el.isConnected) {
        entry.bilingualEl = null;
        this.entries.delete(id);
        continue;
      }
      if (this._mode === 'inline' && entry.inlineSegments) {
        this.renderInlineEntry(entry);
      } else {
        renderEntry(entry, this._mode);
      }
    }
  }

  private renderInlineEntry(entry: NodeEntry): void {
    if (!entry.inlineSegments) return;
    ensureStylesFor(entry.el);
    for (const seg of entry.inlineSegments) {
      if (!seg.dstEl) continue;
      seg.dstEl.classList.remove('wt-inline-error', 'wt-inline-pending');
      if (seg.status === 'done' && seg.translated !== null) {
        seg.dstEl.textContent = seg.translated;
      } else if (seg.status === 'error') {
        seg.dstEl.textContent = `〔翻译失败〕`;
        seg.dstEl.classList.add('wt-inline-error');
      } else if (seg.status === 'pending') {
        seg.dstEl.textContent = '…';
        seg.dstEl.classList.add('wt-inline-pending');
      } else {
        seg.dstEl.textContent = '…';
      }
    }
    // Keep entry-level aggregate in sync for state().
    entry.status = this.effectiveStatus(entry);
  }

  private report(): void {
    this.onStateChange?.(this.state());
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
      if (this.config.streamingAvailable) {
        this.translateEntryStreaming(entry);
      } else {
        void this.fetchTranslations([entry]);
      }
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