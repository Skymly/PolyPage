/**
 * Subtitle overlay style helpers (spec 4.0 §7.3).
 *
 * Pure functions so cue row order, background and vertical band can be
 * tested without a <video> element. VideoSubtitleController applies the
 * results to the Shadow DOM layer.
 */
import type { SubtitleBilingual, SubtitlePosition } from '../shared/types';

export interface SubtitleStyleConfig {
  bilingual: SubtitleBilingual;
  fontSizePct: number;
  swapSrcDst: boolean;
  background: string;
  position: SubtitlePosition;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = {
  bilingual: 'both',
  fontSizePct: 100,
  swapSrcDst: false,
  background: 'rgba(0,0,0,.62)',
  position: 'bottom',
};

export type CueLineKind = 'src' | 'dst';

/**
 * Row order for the bilingual overlay.
 * Default (swapSrcDst=false): source above, translation below.
 * swapSrcDst=true: translation above, source below (spec 4.0 §7.3).
 */
export function cueLineOrder(bilingual: SubtitleBilingual, swapSrcDst: boolean): CueLineKind[] {
  const showSrc = bilingual === 'both' || bilingual === 'src';
  const showDst = bilingual === 'both' || bilingual === 'dst';
  if (swapSrcDst) {
    return [...(showDst ? (['dst'] as const) : []), ...(showSrc ? (['src'] as const) : [])];
  }
  return [...(showSrc ? (['src'] as const) : []), ...(showDst ? (['dst'] as const) : [])];
}

/** Vertical fraction of the video box used as the overlay `top`. */
export function cueVerticalRatio(position: SubtitlePosition): number {
  return position === 'top' ? 0.08 : 0.82;
}

export function cuePositionClass(position: SubtitlePosition): string {
  return position === 'top' ? 'wt-sub-pos-top' : 'wt-sub-pos-bottom';
}
