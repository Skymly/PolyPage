/**
 * Shared teardown for `wt:restore` and `wt:toggle` off (M-85).
 * Content-script wiring stays in index.ts; this module is unit-tested.
 */
export interface PageRestoreTargets {
  abortAsr(): string | null;
  restoreTranslator(): void;
  restoreSubtitles(): void;
  removeOverlay(): void;
  stopObserver(): void;
  scheduleReport(): void;
}

/** Run ASR cancel + translator/subtitle/overlay restore in a fixed order. */
export function restorePage(targets: PageRestoreTargets): string | null {
  const asrRequestId = targets.abortAsr();
  targets.restoreTranslator();
  targets.restoreSubtitles();
  targets.removeOverlay();
  targets.stopObserver();
  targets.scheduleReport();
  return asrRequestId;
}
