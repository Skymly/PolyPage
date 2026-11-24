import { stripVttTags } from './subtitleScheduler';
import type { CueLike } from './subtitleScheduler';

/** Resolve simultaneous native cues with the same joined key used for display. */
export function translatedIntervals(cues: CueLike[], translated: (source: string) => string | null): CueLike[] {
  const events = new Map<number, { add: number[]; remove: number[] }>();
  function at(time: number) {
    let event = events.get(time);
    if (!event) events.set(time, event = { add: [], remove: [] });
    return event;
  }
  cues.forEach((cue, index) => {
    if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime) || cue.endTime <= cue.startTime) return;
    at(cue.startTime).add.push(index);
    at(cue.endTime).remove.push(index);
  });
  const times = [...events.keys()].sort((a, b) => a - b);
  const active = new Set<number>();
  const out: CueLike[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const event = events.get(times[i])!;
    event.remove.forEach(id => active.delete(id));
    event.add.forEach(id => active.add(id));
    if (!active.size) continue;
    const lines = [...active].sort((a, b) => a - b).map(id => cues[id].text);
    const key = lines.map(stripVttTags).filter(Boolean).join(' ');
    const translation = translated(key);
    if (translation) out.push({ startTime: times[i], endTime: times[i + 1], text: lines.join('\n'), translation });
  }
  return out;
}

function timestamp(ms: number): string {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor(ms / 60000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}

/** Replaying a player-drawn caption may observe a different portion of the same interval. */
export function mergeWatchedIntervals(cues: CueLike[]): CueLike[] {
  const last = new Map<string, CueLike>();
  const out: CueLike[] = [];
  for (const cue of [...cues].sort((a, b) => a.startTime - b.startTime)) {
    const key = JSON.stringify([cue.text, cue.translation]);
    const prev = last.get(key);
    if (prev && cue.startTime < prev.endTime) {
      prev.endTime = Math.max(prev.endTime, cue.endTime);
    } else {
      const copy = { ...cue };
      out.push(copy);
      last.set(key, copy);
    }
  }
  return out;
}

export function bilingualSrt(cues: CueLike[]): string {
  const blocks: string[] = [];
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  for (const cue of sorted) {
    const start = Math.round(cue.startTime * 1000);
    const end = Math.round(cue.endTime * 1000);
    const source = cue.text.split(/\r\n?|\n/).map(stripVttTags).filter(Boolean).join('\r\n');
    const dst = cue.translation?.split(/\r\n?|\n/).map(s => s.trim()).filter(Boolean).join('\r\n');
    if (!source || !dst || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    blocks.push(`${blocks.length + 1}\r\n${timestamp(start)} --> ${timestamp(end)}\r\n${source}\r\n${dst}`);
  }
  return blocks.length ? '\uFEFF' + blocks.join('\r\n\r\n') + '\r\n' : '';
}
