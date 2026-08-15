/**
 * ASR capability probe + transcript normalization (spec 4.0 §5.4).
 */
import type { TranslationProvider } from '../providers/provider';
import { providerSupportsAsr } from '../providers/provider';
import { segmentTranscript } from './segment';
import type { AsrSegment } from './segment';

export function asrAvailable(provider: TranslationProvider | null | undefined): boolean {
  return !!provider && providerSupportsAsr(provider);
}

export function normalizeTranscript(
  raw: { text: string; segments?: Array<{ start?: number; end?: number; text?: string }> },
  windowStart: number,
  windowDuration: number,
): AsrSegment[] {
  return segmentTranscript(raw, windowStart, windowDuration);
}
