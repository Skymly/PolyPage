/**
 * Video subtitle translation (spec 3.0 pillar G / §7).
 *
 * MVP: `<track>` takeover — original tracks switch to mode "hidden" (never
 * removed, video source untouched), cue text flows through the background
 * immediate path (translate-cue) and renders in a self-drawn Shadow DOM
 * layer. Closing restores everything with zero residue (spec §7.1 item 7).
 *
 * P1: `subtitleSelectors` site rules watch self-drawn subtitle DOM
 * (e.g. YouTube caption segments) and translate in place with hover-to-see-
 * original (spec §7.2).
 */
import { sendRuntime } from '../messaging/messages';
import type { SubtitleBilingual, SubtitleState } from '../shared/types';
import { CueScheduler, activeCueText, stripVttTags } from './subtitleScheduler';
import type { CueLike } from './subtitleScheduler';

const SUB_CSS = `
:host { all: initial; }
.wt-sub-box {
  position: fixed; z-index: 2147483646; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  font-family: system-ui, -apple-system, sans-serif;
  text-align: center; max-width: 86vw;
}
.wt-sub-row { padding: 2px 10px; border-radius: 4px; background: rgba(0,0,0,.62); color: #fff; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.wt-sub-src { font-size: .82em; color: #d8dbe4; }
.wt-sub-dst { font-size: 1em; }
.wt-sub-mark {
  pointer-events: auto; display: none; margin-top: 2px;
  border: 1px solid rgba(255,255,255,.45); background: rgba(0,0,0,.55);
  color: #fff; border-radius: 4px; font-size: 11px; padding: 0 8px; cursor: pointer;
}
.wt-sub-box:hover .wt-sub-mark { display: inline-block; }
`;

interface CueHost {
  host: HTMLElement;
  box: HTMLElement;
}

class VideoSubtitleController {
  private savedModes: { track: TextTrack; mode: TextTrackMode }[] = [];
  private timer: number | null = null;
  private scheduler = new CueScheduler();
  private cueHost: CueHost | null = null;
  private lastRendered: string | null = null;
  private bilingual: SubtitleBilingual = 'both';
  private fontSizePct = 100;

  constructor(private readonly video: HTMLVideoElement) {}

  get hasTracks(): boolean {
    return this.subtitleTracks().length > 0;
  }

  private subtitleTracks(): TextTrack[] {
    return Array.from(this.video.textTracks ?? []).filter(
      (t) => t.kind === 'subtitles' || t.kind === 'captions',
    );
  }

  private collectCues(): CueLike[] {
    const out: CueLike[] = [];
    for (const track of this.subtitleTracks()) {
      const cues = track.cues;
      if (!cues) continue;
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        out.push({ startTime: cue.startTime, endTime: cue.endTime, text: (cue as VTTCue).text });
      }
    }
    return out;
  }

  setStyles(bilingual: SubtitleBilingual, fontSizePct: number): void {
    this.bilingual = bilingual;
    this.fontSizePct = fontSizePct;
    this.lastRendered = null; // force re-render
    this.tick();
  }

  takeover(): void {
    if (this.savedModes.length > 0) return;
    for (const track of this.subtitleTracks()) {
      this.savedModes.push({ track, mode: track.mode });
      track.mode = 'hidden';
      track.addEventListener('cuechange', this.onCueChange);
    }
    this.ensureLayer();
    this.timer = window.setInterval(this.tick, 250);
    this.tick();
  }

  restore(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const { track, mode } of this.savedModes) {
      track.removeEventListener('cuechange', this.onCueChange);
      track.mode = mode;
    }
    this.savedModes = [];
    this.cueHost?.host.remove();
    this.cueHost = null;
    this.scheduler.reset();
    this.lastRendered = null;
  }

  get active(): boolean {
    return this.savedModes.length > 0;
  }

  private onCueChange = (): void => {
    this.tick();
  };

  private ensureLayer(): void {
    if (this.cueHost) return;
    const host = document.createElement('div');
    host.className = 'wt-subtitle-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SUB_CSS;
    const box = document.createElement('div');
    box.className = 'wt-sub-box';
    shadow.append(style, box);
    document.documentElement.appendChild(host);
    this.cueHost = { host, box };
  }

  /** Position the fixed layer over the video's bottom area. */
  private positionLayer(): void {
    if (!this.cueHost) return;
    const rect = this.video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.cueHost.box.style.display = 'none';
      return;
    }
    this.cueHost.box.style.display = '';
    const baseFont = Math.max(13, Math.min(24, rect.height * 0.045));
    this.cueHost.box.style.fontSize = `${((baseFont * this.fontSizePct) / 100).toFixed(1)}px`;
    this.cueHost.box.style.left = `${Math.round(rect.left)}px`;
    this.cueHost.box.style.width = `${Math.round(rect.width)}px`;
    this.cueHost.box.style.top = `${Math.round(rect.top + rect.height * 0.82)}px`;
  }

  private tick = (): void => {
    if (!this.active) return;
    this.positionLayer();
    const cues = this.collectCues();
    const time = this.video.currentTime;
    const decision = this.scheduler.decide(cues, time);
    if (decision.kind === 'none') {
      // Keep last frame only while a fetch is in flight; otherwise clear.
      if (this.lastRendered !== null && activeCueText(cues, time) === null) {
        this.render(null, null);
        this.lastRendered = null;
      }
      return;
    }
    if (decision.kind === 'fetch') {
      this.render(decision.text, null);
      void this.fetchTranslation(decision.text);
      return;
    }
    if (this.lastRendered !== `${decision.text}|${decision.translation ?? ''}`) {
      this.render(decision.text, decision.translation);
      this.lastRendered = `${decision.text}|${decision.translation ?? ''}`;
    }
  };

  private async fetchTranslation(text: string): Promise<void> {
    try {
      const res = await sendRuntime({ type: 'translate-cue', text, domain: location.hostname });
      if (res?.ok && res.translated !== undefined) {
        this.scheduler.resolve(text, res.translated);
      } else {
        this.scheduler.resolve(text, null);
      }
    } catch {
      this.scheduler.resolve(text, null);
    }
    if (this.active) {
      this.lastRendered = null;
      this.tick();
    }
  }

  private render(source: string | null, translation: string | null): void {
    if (!this.cueHost) return;
    const box = this.cueHost.box;
    box.innerHTML = '';
    if (source === null) {
      return;
    }
    const showSrc = this.bilingual === 'both' || this.bilingual === 'src';
    const showDst = this.bilingual === 'both' || this.bilingual === 'dst';
    if (showDst) {
      const dst = document.createElement('div');
      dst.className = 'wt-sub-row wt-sub-dst';
      dst.textContent = translation ?? '…';
      box.appendChild(dst);
    }
    if (showSrc) {
      const src = document.createElement('div');
      src.className = 'wt-sub-row wt-sub-src';
      src.textContent = source;
      box.appendChild(src);
    }
    if (translation !== null) {
      const mark = document.createElement('button');
      mark.className = 'wt-sub-mark';
      mark.textContent = '标记坏句';
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        void sendRuntime({
          type: 'mark-feedback',
          source,
          translation,
          pageUrl: location.href,
          where: 'subtitle',
        }).then(() => {
          mark.textContent = '已标记';
          window.setTimeout(() => (mark.textContent = '标记坏句'), 1200);
        });
      });
      box.appendChild(mark);
    }
  }
}

/* ------------------------------ manager + wiring ------------------------------ */

export class SubtitleManager {
  private controllers = new Map<HTMLVideoElement, VideoSubtitleController>();
  private activeVideo: HTMLVideoElement | null = null;
  private bilingual: SubtitleBilingual = 'both';
  private fontSizePct = 100;
  private selectorObserver: MutationObserver | null = null;
  private selectorTimer: number | null = null;
  private selectorDirty = new Set<Element>();
  /** subtitleSelectors in-place replacements: node -> original text. */
  private replaced = new Map<Element, string>();
  private selectors: string[] = [];
  private wired = false;

  configure(bilingual: SubtitleBilingual, fontSizePct: number): void {
    this.bilingual = bilingual;
    this.fontSizePct = fontSizePct;
    for (const controller of this.controllers.values()) {
      controller.setStyles(bilingual, fontSizePct);
    }
  }

  private wireInteraction(): void {
    if (this.wired) return;
    this.wired = true;
    document.addEventListener(
      'mouseenter',
      (e) => {
        if (e.target instanceof HTMLVideoElement) this.activeVideo = e.target;
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        if (e.target instanceof HTMLVideoElement) this.activeVideo = e.target;
      },
      true,
    );
  }

  private videos(): HTMLVideoElement[] {
    return Array.from(document.querySelectorAll('video'));
  }

  private controllerFor(video: HTMLVideoElement): VideoSubtitleController {
    let controller = this.controllers.get(video);
    if (!controller) {
      controller = new VideoSubtitleController(video);
      this.controllers.set(video, controller);
    }
    return controller;
  }

  /** Number of videos carrying subtitle/caption tracks. */
  subtitleVideoCount(): number {
    return this.videos().filter((v) => this.controllerFor(v).hasTracks).length;
  }

  state(): SubtitleState {
    const withTracks = this.videos().filter((v) => this.controllerFor(v).hasTracks);
    if (withTracks.length === 0) return 'unavailable';
    return withTracks.some((v) => this.controllerFor(v).active) ? 'on' : 'off';
  }

  /** Toggle subtitles on the active (last-interacted) video (spec §7.1 item 6). */
  toggle(): SubtitleState {
    this.wireInteraction();
    const candidates = this.videos().filter((v) => this.controllerFor(v).hasTracks);
    if (candidates.length === 0) return 'unavailable';
    const target =
      this.activeVideo && candidates.includes(this.activeVideo)
        ? this.activeVideo
        : candidates[0];
    const controller = this.controllerFor(target);
    if (controller.active) {
      controller.restore();
    } else {
      controller.setStyles(this.bilingual, this.fontSizePct);
      controller.takeover();
    }
    return this.state();
  }

  restoreAll(): void {
    for (const controller of this.controllers.values()) controller.restore();
    this.restoreSelectors();
  }

  /* ------------------------- subtitleSelectors (P1) ------------------------- */

  applySelectors(selectors: string[]): void {
    this.selectors = selectors;
    if (selectors.length === 0) {
      this.restoreSelectors();
      return;
    }
    if (this.selectorObserver) return;
    this.selectorObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const node =
          mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
        if (!(node instanceof Element)) continue;
        const matched = node.matches?.(this.selectors.join(','))
          ? node
          : node.querySelector?.(this.selectors.join(','));
        if (matched) this.selectorDirty.add(matched);
      }
      if (this.selectorDirty.size === 0) return;
      if (this.selectorTimer !== null) return;
      // 150ms debounce (spec 3.0 §7.2 item 1).
      this.selectorTimer = window.setTimeout(() => {
        this.selectorTimer = null;
        const dirty = [...this.selectorDirty];
        this.selectorDirty.clear();
        for (const el of dirty) void this.translateSelectorNode(el);
      }, 150);
    });
    this.selectorObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Prime existing nodes.
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        this.selectorDirty.add(el);
      }
    }
    if (this.selectorDirty.size > 0 && this.selectorTimer === null) {
      this.selectorTimer = window.setTimeout(() => {
        this.selectorTimer = null;
        const dirty = [...this.selectorDirty];
        this.selectorDirty.clear();
        for (const el of dirty) void this.translateSelectorNode(el);
      }, 150);
    }
  }

  private async translateSelectorNode(el: Element): Promise<void> {
    const original = this.replaced.get(el) ?? (el.textContent ?? '').trim();
    const current = (el.textContent ?? '').trim();
    if (current === '' || current === this.replaced.get(el)) return;
    // Never translate our own translations again.
    if (el.getAttribute('data-wt-sub') === '1') return;
    try {
      const res = await sendRuntime({
        type: 'translate-cue',
        text: stripVttTags(current),
        domain: location.hostname,
      });
      if (res?.ok && res.translated) {
        this.replaced.set(el, original);
        el.setAttribute('data-wt-sub', '1');
        el.setAttribute('title', original); // hover to see original
        el.textContent = res.translated;
      }
    } catch {
      /* background unavailable; node stays original */
    }
  }

  restoreSelectors(): void {
    this.selectorObserver?.disconnect();
    this.selectorObserver = null;
    if (this.selectorTimer !== null) {
      window.clearTimeout(this.selectorTimer);
      this.selectorTimer = null;
    }
    for (const [el, original] of this.replaced) {
      if (el.isConnected) {
        el.textContent = original;
        el.removeAttribute('data-wt-sub');
        el.removeAttribute('title');
      }
    }
    this.replaced.clear();
    this.selectorDirty.clear();
  }

  get selectorList(): string[] {
    return this.selectors;
  }
}