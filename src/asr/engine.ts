/**
 * ASR capability probe + transcript normalization (spec 4.0 §5.4).
 */
import type { TranslationProvider } from '../providers/provider';
import { providerSupportsAsr, providerSupportsAsrStreaming } from '../providers/provider';
import { segmentTranscript } from './segment';
import type { AsrSegment } from './segment';

export function asrAvailable(provider: TranslationProvider | null | undefined): boolean {
  return !!provider && providerSupportsAsr(provider);
}

/** True only when the user enabled streaming AND the backend implements transcribeStream. */
export function asrStreamingAvailable(
  provider: TranslationProvider | null | undefined,
  streamingEnabled: boolean,
): boolean {
  return streamingEnabled === true && !!provider && providerSupportsAsrStreaming(provider);
}

export function normalizeTranscript(
  raw: { text: string; segments?: Array<{ start?: number; end?: number; text?: string }> },
  windowStart: number,
  windowDuration: number,
): AsrSegment[] {
  return segmentTranscript(raw, windowStart, windowDuration);
}
