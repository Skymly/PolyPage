import { MEDIA_COMMAND_FRAME_ID, sendTabCommand } from '../messaging/messages';
import type { AsrResponse } from '../messaging/messages';
import { AsrRoundTrip } from '../asr/roundtrip';
import { createProvider } from '../providers/provider';
import { base64ToBytes } from '../shared/binaryChunk';
import { recordStat } from './diagnostics';
import { getSettings } from './settingsState';
import { translateMediaTexts } from './translationRequests';

const asrControllers = new Map<string, AbortController>();

const asrRoundTrip = new AsrRoundTrip({
  getSettings,
  createProvider,
  translateTexts: (texts) => translateMediaTexts(texts, 'asr'),
  recordStat,
});

export async function handleAsrStart(
  requestId: string,
  mime: string,
  base64: string,
  windowStart: number,
  windowDuration: number,
  languageHint?: string,
  tabId?: number,
): Promise<AsrResponse> {
  const settings = await getSettings(true);
  const controller = new AbortController();
  asrControllers.set(requestId, controller);
  try {
    const bytes = base64ToBytes(base64);
    return await asrRoundTrip.transcribeAndTranslate({
      mime,
      bytes,
      windowStart,
      windowDuration,
      languageHint,
      signal: controller.signal,
      emitPartials: settings.asr.streaming === true && tabId !== undefined,
      onPartial:
        tabId !== undefined
          ? async (cues) => {
              try {
                await sendTabCommand(
                  tabId,
                  { type: 'wt:asr-partial', cues },
                  { frameId: MEDIA_COMMAND_FRAME_ID },
                );
              } catch {
                /* tab gone or no receiver */
              }
            }
          : undefined,
    });
  } finally {
    asrControllers.delete(requestId);
  }
}

export function cancelAsr(requestId: string): void {
  asrControllers.get(requestId)?.abort();
}
