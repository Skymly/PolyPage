import { sendRuntime } from '../messaging/messages';
import { CueScheduler, type CueLike } from './subtitleScheduler';
import { mergeWatchedIntervals } from './subtitleExport';

/** A DOM caption has no file timestamps. Keep only intervals actually observed on the media clock. */
export class DomCaptionSession {
  private rows = new Map<Element, { source: string; cue: CueLike }>();
  private history: CueLike[] = [];
  private scheduler = new CueScheduler();
  private timer: number;
  private css = document.createElement('style');
  private media: HTMLVideoElement | null = null;
  private source = '';
  private language = '';
  private disposed = false;
  private readonly attribute = 'data-wt-caption-translation';

  constructor(private read: () => { media: HTMLVideoElement | null; nodes: Element[] }) {
    this.css.textContent = `[${this.attribute}]::after { content: attr(${this.attribute}); display: block; color: white; background: rgba(0,0,0,.72); white-space: pre-wrap; }`;
    document.documentElement.append(this.css);
    this.timer = window.setInterval(() => this.sample(), 150);
    this.sample();
  }

  private resetRows = (): void => {
    for (const el of this.rows.keys()) el.removeAttribute(this.attribute);
    this.rows.clear();
  };

  sample(): void {
    const { media, nodes } = this.read();
    if (media !== this.media || (media?.currentSrc ?? '') !== this.source) {
      this.resetRows();
      this.history = [];
      this.scheduler = new CueScheduler();
      this.media?.removeEventListener('seeking', this.resetRows);
      this.media = media;
      this.source = media?.currentSrc ?? '';
      this.language = '';
      media?.addEventListener('seeking', this.resetRows);
    }
    if (!media || media.seeking) return;
    const lang = nodes[0]?.closest('[lang]')?.getAttribute('lang');
    if (lang && lang !== this.language) {
      this.resetRows();
      this.history = [];
      this.scheduler = new CueScheduler();
      this.language = lang;
    }
    const time = media.currentTime;
    for (const [el, row] of this.rows) {
      // Never span a seek, including a player that swaps currentTime without an event.
      if (time >= row.cue.endTime && time - row.cue.endTime < 1) row.cue.endTime = time;
      else { this.rows.delete(el); el.removeAttribute(this.attribute); continue; }
      if (!nodes.includes(el) || (el.textContent ?? '').trim() !== row.source) {
        this.rows.delete(el);
        el.removeAttribute(this.attribute);
      }
    }
    for (const el of nodes) {
      const source = (el.textContent ?? '').trim();
      if (!source) continue;
      if (!this.rows.has(el)) {
        const cue = { startTime: time, endTime: time, text: source };
        this.history.push(cue);
        this.rows.set(el, { source, cue });
      }
      const decision = this.scheduler.decideText(source);
      if (decision.kind === 'fetch') {
        void this.translate(source, this.scheduler);
      } else if (decision.kind === 'show' && decision.translation && el.getAttribute(this.attribute) !== decision.translation) {
        el.setAttribute(this.attribute, decision.translation);
      }
    }
  }

  private async translate(source: string, scheduler: CueScheduler): Promise<void> {
    const text = await sendRuntime({ type: 'translate-cue', text: source, domain: location.hostname })
      .then(res => res?.ok && res.translated ? res.translated : null, () => null);
    scheduler.resolve(source, text);
    if (text && !this.disposed && scheduler === this.scheduler) this.sample();
  }

  exportCues(): CueLike[] {
    this.sample();
    return mergeWatchedIntervals(this.history.map(cue => ({
      ...cue, translation: this.scheduler.cachedTranslation(cue.text) ?? undefined,
    })));
  }

  close(): void {
    this.disposed = true;
    window.clearInterval(this.timer);
    this.media?.removeEventListener('seeking', this.resetRows);
    this.resetRows();
    this.css.remove();
    this.history = [];
    this.scheduler.reset();
  }
}
