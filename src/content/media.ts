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
import type { SubtitleState } from '../shared/types';
import { CueScheduler, activeCueText, mergeMemoryCues, stripVttTags } from './subtitleScheduler';
import type { CueLike } from './subtitleScheduler';
import {
  DEFAULT_SUBTITLE_STYLE,
  cueLineOrder,
  cuePositionClass,
  cueVerticalRatio,
} from './subtitleStyle';
import type { SubtitleStyleConfig } from './subtitleStyle';

/** Mount the self-drawn layer inside native fullscreen when possible (M-32). */
export function subtitleLayerParent(): Element {
  return document.fullscreenElement ?? document.documentElement;
}

/** Match `node` or a descendant against CSS selectors; skip illegal ones (M-86). */
export function matchSelectorAgainstNode(node: Element, selectors: string[]): Element | null {
  for (const sel of selectors) {
    if (!sel) continue;
    try {
      if (node.matches(sel)) return node;
    } catch {
      continue;
    }
    try {
      const child = node.querySelector(sel);
      if (child) return child;
    } catch {
      continue;
    }
  }
  return null;
}

/** `querySelectorAll` per selector, ignoring SyntaxError from bad CSS (M-86). */
export function queryAllSafeSelectors(root: ParentNode, selectors: string[]): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const sel of selectors) {
    if (!sel) continue;
    let found: Element[] = [];
    try {
      found = Array.from(root.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of found) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

const SUB_CSS = `
:host { all: initial; }
.wt-sub-box {
  position: fixed; z-index: 2147483646; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  font-family: system-ui, -apple-system, sans-serif;
  text-align: center; max-width: 86vw;
}
.wt-sub-pos-top { align-items: center; }
.wt-sub-pos-bottom { align-items: center; }
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
  private style: SubtitleStyleConfig = { ...DEFAULT_SUBTITLE_STYLE };
  private memoryCues: CueLike[] = [];
  private fetchEpoch = 0;

  constructor(private readonly media: HTMLMediaElement) {}

  get hasTracks(): boolean {
    return this.subtitleTracks().length > 0;
  }

  get cueCount(): number {
    return this.memoryCues.length;
  }

  cuesSnapshot(): CueLike[] {
    return this.memoryCues.map((c) => ({ ...c }));
  }

  private subtitleTracks(): TextTrack[] {
    if (!(this.media instanceof HTMLVideoElement)) return [];
    return Array.from(this.media.textTracks ?? []).filter(
      (t) => t.kind === 'subtitles' || t.kind === 'captions',
    );
  }

  setMemoryCues(cues: CueLike[]): void {
    this.memoryCues = mergeMemoryCues(this.memoryCues, cues);
    for (const cue of cues) {
      if (cue.translation !== undefined && cue.translation !== '') {
        this.scheduler.resolve(stripVttTags(cue.text) || cue.text, cue.translation);
      }
    }
    this.lastRendered = null;
    this.ensureLayer();
    if (this.timer === null) this.timer = window.setInterval(this.tick, 250);
    this.tick();
  }

  private collectCues(): CueLike[] {
    if (this.memoryCues.length > 0) return this.memoryCues;
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

  setStyles(style: SubtitleStyleConfig): void {
    this.style = { ...style };
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
    this.fetchEpoch += 1;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const { track, mode } of this.savedModes) {
      track.removeEventListener('cuechange', this.onCueChange);
      track.mode = mode;
    }
    this.savedModes = [];
    this.memoryCues = [];
    this.cueHost?.host.remove();
    this.cueHost = null;
    this.scheduler.reset();
    this.lastRendered = null;
  }

  get active(): boolean {
    return this.savedModes.length > 0 || this.memoryCues.length > 0;
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
    subtitleLayerParent().appendChild(host);
    this.cueHost = { host, box };
  }

  syncLayerParent(): void {
    if (!this.cueHost) return;
    const parent = subtitleLayerParent();
    if (this.cueHost.host.parentElement !== parent) parent.appendChild(this.cueHost.host);
  }

  /** PiP cannot show our overlay; restore native tracks while the video is in PiP. */
  setPictureInPicture(active: boolean): void {
    if (this.savedModes.length === 0) return;
    for (const { track, mode } of this.savedModes) {
      track.mode = active ? (mode === 'hidden' || mode === 'disabled' ? 'showing' : mode) : 'hidden';
    }
    if (this.cueHost) this.cueHost.host.style.display = active ? 'none' : '';
  }

  /** Position the fixed layer over the video's bottom area. */
  private positionLayer(): void {
    if (!this.cueHost) return;
    const rect = this.media.getBoundingClientRect();
    this.cueHost.box.style.display = '';
    this.cueHost.box.style.bottom = '';
    if (rect.width < 8 && rect.height < 8) {
      this.cueHost.box.style.left = '8%';
      this.cueHost.box.style.width = '84%';
      this.cueHost.box.style.top = '';
      this.cueHost.box.style.bottom = '8%';
      this.cueHost.box.style.fontSize = `${((16 * this.style.fontSizePct) / 100).toFixed(1)}px`;
    } else {
      const height = Math.max(rect.height, 40);
      const baseFont = Math.max(13, Math.min(24, height * 0.045));
      this.cueHost.box.style.fontSize = `${((baseFont * this.style.fontSizePct) / 100).toFixed(1)}px`;
      this.cueHost.box.style.left = `${Math.round(rect.left)}px`;
      this.cueHost.box.style.width = `${Math.round(Math.max(rect.width, 160))}px`;
      const ratio = cueVerticalRatio(this.style.position);
      this.cueHost.box.style.top = `${Math.round(rect.top + height * ratio)}px`;
    }
    this.cueHost.box.classList.remove('wt-sub-pos-top', 'wt-sub-pos-bottom');
    this.cueHost.box.classList.add(cuePositionClass(this.style.position));
  }

  private tick = (): void => {
    if (!this.active) return;
    this.positionLayer();
    const cues = this.collectCues();
    const time = this.media.currentTime;
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
      if (this.memoryCues.length > 0) {
        this.render(decision.text, this.scheduler.cachedTranslation(decision.text));
        return;
      }
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
    const started = this.fetchEpoch;
    try {
      const res = await sendRuntime({ type: 'translate-cue', text, domain: location.hostname });
      if (!shouldCommitCueFetch(started, this.fetchEpoch, this.active)) return;
      if (res?.ok && res.translated !== undefined) {
        this.scheduler.resolve(text, res.translated);
      } else {
        this.scheduler.resolve(text, null);
      }
    } catch {
      if (!shouldCommitCueFetch(started, this.fetchEpoch, this.active)) return;
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
    for (const kind of cueLineOrder(this.style.bilingual, this.style.swapSrcDst)) {
      const row = document.createElement('div');
      row.className = `wt-sub-row wt-sub-${kind}`;
      row.style.background = this.style.background;
      row.textContent = kind === 'src' ? source : (translation ?? '…');
      box.appendChild(row);
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
  private controllers = new Map<HTMLMediaElement, VideoSubtitleController>();
  private activeVideo: HTMLVideoElement | null = null;
  /** Media that started the current ASR capture; partials must not re-pick. */
  private asrTarget: HTMLMediaElement | null = null;
  private style: SubtitleStyleConfig = { ...DEFAULT_SUBTITLE_STYLE };
  private selectorObserver: MutationObserver | null = null;
  private selectorTimer: number | null = null;
  private selectorDirty = new Set<Element>();
  /** subtitleSelectors in-place replacements: node -> original text. */
  private replaced = new Map<Element, string>();
  private selectors: string[] = [];
  private wired = false;
  private pipWired = new Set<HTMLVideoElement>();

  configure(style: SubtitleStyleConfig): void {
    this.style = { ...style };
    for (const controller of this.controllers.values()) {
      controller.setStyles(style);
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
    document.addEventListener('fullscreenchange', () => this.syncPresentation());
  }

  syncPresentation(): void {
    this.wireInteraction();
    for (const controller of this.controllers.values()) {
      controller.syncLayerParent();
    }
    for (const video of this.videos()) {
      const pip = document.pictureInPictureElement === video;
      this.controllerFor(video).setPictureInPicture(pip);
      if (!this.pipWired.has(video)) {
        this.pipWired.add(video);
        video.addEventListener('enterpictureinpicture', () => this.syncPresentation());
        video.addEventListener('leavepictureinpicture', () => this.syncPresentation());
      }
    }
  }

  private videos(): HTMLVideoElement[] {
    return Array.from(document.querySelectorAll('video'));
  }

  private controllerFor(media: HTMLMediaElement): VideoSubtitleController {
    let controller = this.controllers.get(media);
    if (!controller) {
      controller = new VideoSubtitleController(media);
      this.controllers.set(media, controller);
    }
    return controller;
  }

  /** Number of videos carrying subtitle/caption tracks. */
  subtitleVideoCount(): number {
    return this.videos().filter((v) => this.controllerFor(v).hasTracks).length;
  }

  captionlessMediaCount(): number {
    const videos = this.videos().filter((v) => !this.controllerFor(v).hasTracks).length;
    const audios = document.querySelectorAll('audio').length;
    return videos + audios;
  }

  asrActive(): boolean {
    return [...this.controllers.values()].some((c) => c.active && !c.hasTracks);
  }

  applyMemoryCues(media: HTMLMediaElement, cues: CueLike[]): void {
    const controller = this.controllerFor(media);
    controller.setStyles(this.style);
    controller.setMemoryCues(cues);
    this.syncPresentation();
  }

  pinAsrTarget(media: HTMLMediaElement): void {
    this.asrTarget = media;
  }

  asrTargetMedia(): HTMLMediaElement | null {
    if (!this.asrTarget || !this.asrTarget.isConnected) {
      this.asrTarget = null;
      return null;
    }
    return this.asrTarget;
  }

  applyAsrPartial(cues: CueLike[]): void {
    const media = this.asrTargetMedia() ?? this.pickCaptionlessMedia();
    if (media) this.applyMemoryCues(media, cues);
  }

  memoryCueCount(media: HTMLMediaElement): number {
    return this.controllers.get(media)?.cueCount ?? 0;
  }

  memoryCuesOf(media: HTMLMediaElement): CueLike[] {
    return this.controllers.get(media)?.cuesSnapshot() ?? [];
  }

  pickCaptionlessMedia(): HTMLMediaElement | null {
    this.wireInteraction();
    const videos = this.videos().filter((v) => !this.controllerFor(v).hasTracks);
    if (this.activeVideo && videos.includes(this.activeVideo)) return this.activeVideo;
    if (videos[0]) return videos[0];
    return document.querySelector('audio');
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
      controller.setStyles(this.style);
      controller.takeover();
      this.syncPresentation();
    }
    return this.state();
  }

  restoreAll(): void {
    this.asrTarget = null;
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
      try {
        for (const mutation of mutations) {
          const node =
            mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
          if (!(node instanceof Element)) continue;
          const matched = matchSelectorAgainstNode(node, this.selectors);
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
      } catch {
        /* illegal selector / detached node — keep observing (M-86) */
      }
    });
    this.selectorObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Prime existing nodes.
    for (const el of queryAllSafeSelectors(document, selectors)) {
      this.selectorDirty.add(el);
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

/** Reject whole-file fetch fallback (M-11): it ignores the confirmed window. */
export function rejectWholeFileFallback(cause: unknown): { ok: false; error: string } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    ok: false,
    error: `无法采集当前窗口（${detail}）。已拒绝下载整段文件，请改用可采集音轨的播放器。`,
  };
}

/** Always call sendResponse, including when the command promise rejects (M-11). */
export function settleTabResponse(
  work: Promise<unknown>,
  sendResponse: (value: unknown) => void,
): void {
  void work.then(sendResponse, (error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === '请求已取消');
}

export function abortError(): Error {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

/** Abortable delay used by capture so restore / pagehide can stop the window. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** In-flight ASR capture / round-trip (M-10). */
export class AsrSession {
  private controller: AbortController | null = null;
  requestId: string | null = null;

  get active(): boolean {
    return this.controller !== null && !this.controller.signal.aborted;
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  start(): { requestId: string; signal: AbortSignal } {
    this.controller = new AbortController();
    this.requestId = `asr-${Date.now()}`;
    return { requestId: this.requestId, signal: this.controller.signal };
  }

  abort(): string | null {
    const id = this.requestId;
    this.controller?.abort();
    return id;
  }

  finish(): void {
    this.controller = null;
    this.requestId = null;
  }
}

/** Hard cap after the user confirms a full-file capture (M-88). */
export const ASR_FULL_CONFIRM_CAP_SECONDS = 30 * 60;

export function resolveCaptureDuration(input: {
  mediaDuration: number;
  currentTime: number;
  maxSeconds: number;
  confirmFull: boolean;
  confirmFullNow: (remaining: number) => boolean;
  fullCapSeconds?: number;
}): { duration: number; ended?: boolean } {
  const maxSeconds = Math.max(1, input.maxSeconds);
  const cap = input.fullCapSeconds ?? ASR_FULL_CONFIRM_CAP_SECONDS;
  const known = Number.isFinite(input.mediaDuration) && input.mediaDuration > 0;
  if (!known) return { duration: maxSeconds };
  const remaining = Math.max(0, input.mediaDuration - (input.currentTime || 0));
  if (remaining === 0) return { duration: 0, ended: true };
  let duration = Math.min(maxSeconds, remaining);
  if (input.confirmFull && remaining > maxSeconds && input.confirmFullNow(remaining)) {
    duration = Math.min(remaining, cap);
  }
  return { duration };
}

/** Drop translate-cue results that arrive after restore (M-88). */
export function shouldCommitCueFetch(startedEpoch: number, currentEpoch: number, active: boolean): boolean {
  return active && startedEpoch === currentEpoch;
}

export async function captureMediaWindow(
  media: HTMLMediaElement,
  maxSeconds: number,
  signal?: AbortSignal,
): Promise<{ mime: string; bytes: Uint8Array; start: number; duration: number }> {
  if (signal?.aborted) throw abortError();
  const start = media.currentTime || 0;
  const resolved = resolveCaptureDuration({
    mediaDuration: media.duration,
    currentTime: start,
    maxSeconds,
    confirmFull: false,
    confirmFullNow: () => false,
  });
  if (resolved.ended || resolved.duration <= 0) {
    throw new Error('媒体已播放完毕');
  }
  const duration = resolved.duration;
  const streamFn = (
    media as HTMLMediaElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }
  ).captureStream?.bind(media) ??
    (media as HTMLMediaElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.bind(media);
  if (!streamFn) {
    throw new Error('当前媒体无法 captureStream（可能受 DRM 保护或浏览器不支持）');
  }
  let audioTracks: MediaStreamTrack[] = [];
  const stopTracks = (recorder?: MediaRecorder): void => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    audioTracks.forEach((t) => t.stop());
  };
  try {
    let stream: MediaStream;
    try {
      stream = streamFn();
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'captureStream 失败');
    }
    audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) throw new Error('媒体没有可采集的音轨');
    const audioOnly = new MediaStream(audioTracks);
    const mime = pickRecorderMime();
    const recorder = mime ? new MediaRecorder(audioOnly, { mimeType: mime }) : new MediaRecorder(audioOnly);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('MediaRecorder 失败'));
    });
    recorder.start(250);
    if (media.paused) {
      try {
        await media.play();
      } catch {
        /* user gesture may be required; keep recording silence */
      }
    }
    try {
      await delay(Math.max(200, duration * 1000), signal);
    } catch (e) {
      stopTracks(recorder);
      await stopped.catch(() => undefined);
      throw e;
    }
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    audioTracks.forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { mime: blob.type || 'audio/webm', bytes, start, duration };
  } catch (e) {
    stopTracks();
    throw e;
  }
}

function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}