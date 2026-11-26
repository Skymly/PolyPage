# PolyPage — Web Translator Extension

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

Web translation browser extension **4.2.1** (Chrome / Edge release mainline, Firefox MV3 temporarily loadable MVP; Manifest V3, TypeScript + C#/.NET local gateway).

Bring your own **LLM / translation API / local model** to translate web pages, PDFs, images, video subtitles, and subtitle-free audio/video:

- Six web display modes, including original / translated / bilingual / **in-paragraph inline comparison**;
- **Bilingual PDF reader**: in-extension reader page (local pdf.js), per-page text clustering, lazy per-page translation, document fingerprint caching (zero API calls when reopening), and OCR support on scanned pages via the active OCR engine;
- **Image text translation (OCR)**: triggered via context menu / hover button; one-step multimodal vision translation, or **local `tesseract-wasm` recognition followed by the text pipeline**; Shadow DOM result panel;
- **Video subtitle translation**: takes over `<track>` subtitles with a custom bilingual subtitle overlay; `subtitleSelectors` site rules adapt custom-rendered subtitle sites (such as YouTube);
- **Subtitle-free video / audio ASR**: after the user clicks, captures a finite window from the current playback position, transcribes it into in-memory cues, and reuses the same subtitle overlay for translation and restore (never auto-transcribes full media by default);
- **Selection translation + speech synthesis**, `Alt+Q` to repeat the last selection, and **flag-bad-translation feedback log** (CSV/JSON export);
- **Automatic page language detection** (zero-dependency local 12-language detector): populates `auto` source language + same-language auto-translate guard;
- **Resume translation**: persistent background task table (IndexedDB) restores in-flight tasks by tab after Service Worker restarts (cache-idempotent);
- Compatible with **Shadow DOM / iframes (same-origin + cross-origin) / site rules / virtual list viewport translation**;
- Presets and failover chains for **DeepL / Azure Translator / Google Translate / Ollama / Whisper gateway**;
- **Local .NET gateway (Native Messaging Host)**: optional dependency; protocol v2 supports image / transcription / chunking;
- Glossary, bilingual export, translation cache, batch merging, timeout/retry, error classification, and logging.

> Current specification follows `PolyPage-4.2.md` and `docs/VALIDATION-4.2.md`. Completed 1.0–4.1 plans and verification records live in `docs/history/`. See `docs/FIREFOX-MV3.md` for Firefox differences and `docs/store/` for store submission materials.

---

## What's new in 4.2 (per PolyPage-4.2.md)

All 4.1 capabilities are retained. 4.2 introduces no major new features; it focuses on cleaning up translated output, finishing the Firefox gateway last mile, and completing deferred 4.1 polish:

| Pillar | Capabilities |
|---|---|
| P Translation hygiene | Unified stripping of `<think>` / qwen3 fragments; treats empty post-strip results as failures without writing cache/TM; toggleable in Options; hints switching to `api.minimax.chat` when MiniMax Token Plan mistakenly points to `.io` |
| Q Firefox gateway | Loads `dist-firefox/` temporarily via isolated profile + Marionette, then probes `host-status` and one native-host translation; degrades cleanly with an explicit reason on failure |
| R Streaming / overlay / layout | Injects cues only when `transcribeStream` is actually implemented; recalculates overlays on scroll; PDF table fixtures |

Settings `schemaVersion: 6`. Message protocol marker `v: 6`. Gateway `4.2.1`, `ProtocolVersion = 2`.

## What's new in 4.1 (per docs/history/PolyPage-4.1.md)

All 4.0 capabilities are retained. 4.1 fulfills remaining items:

| Pillar | Capabilities |
|---|---|
| M Sentence TM | Dedicated IndexedDB; off by default; normalized exact match skips Provider; 5000-entry ring buffer; clearable in Options; omitted from exports |
| N OCR language packs | Download `jpn`/`kor`/`fra`/`deu` (`tessdata_fast` + hash verification) in Options; passed to Tesseract alongside `eng`/`chi_sim` during recognition |
| O Firefox gateway | Loads `dist-firefox/` temporarily, then performs `connectNative` ping + one translation, or fails over with an explicit reason |
| P1/P2 | Streaming cues enabled only when supported; in-place image overlay off by default; PDF single-column/two-column/table presets |

Settings `schemaVersion: 5`. Message protocol marker `v: 5`. Gateway `4.1.0`, `ProtocolVersion = 2`.

## What's new in 4.0 (per docs/history/PolyPage-4.0.md)

All 3.0 capabilities — six web modes, PDF / image / subtitled video, and UX polish — are retained. 4.0 additions:

| Pillar | Capabilities |
|---|---|
| I Speech & subtitle-free video | User-triggered capture (90-second default window; secondary confirmation for full media); `Provider.transcribe` or gateway Whisper; results segmented into in-memory cues reusing the 3.0 subtitle overlay; videos with `<track>` do not route through ASR by default |
| J Gateway multimodal | Protocol v2 (additive only): `translate.image` / `transcribe` / `binary.chunk`; capabilities add `supportsVision` / `supportsAsr`; `WhisperBackend` orchestrates user-installed `whisper.cpp` / `faster-whisper` without bundling weights |
| K Offline & quality | Real `tesseract-wasm` (`eng` + `chi_sim` bundled locally); "Recognize this page" on scanned PDFs runs through the active `OcrEngine`; subtitle top/bottom swap / background / vertical position; schema v4 (v3→v4 fills defaults only) |
| L Distributable | `dist-firefox/` is temporarily loadable; installer writes Mozilla Native Messaging keys; `docs/store` privacy / permissions / listing drafts. AMO publishing is not a 4.0 exit gate |

Message protocol marker `v: 4` (v1–v3 compatible). Settings `schemaVersion: 4`. Gateway `4.0.0`, `ProtocolVersion = 2`.

See `docs/history/PolyPage-4.1.md` for the 4.1 plan and `PolyPage-4.2.md` for the 4.2 plan (incorporating `docs/history/VALIDATION-4.1.md` §4: translation hygiene and Firefox in-process gateway as P0; streaming cues / overlay polish as P1; table fixtures as P2).

## Directory layout

```text
├── public/
│   ├── icons/                  # Icons generated by the build script
│   └── manifest.json           # MV3 manifest 4.2.1 (optional webNavigation, no microphone)
├── src/
│   ├── background/             # service-worker + nativePort (queue/failover/OCR/ASR/resume)
│   ├── content/                # Web translation + subtitle overlay + selection + image button + ASR capture
│   ├── asr/                    # ★ Transcript segmentation (using segments or even plain-text split)
│   ├── viewer/                 # Bilingual PDF reader (with scanned-page OCR)
│   ├── ocr/                    # OcrEngine + llm-vision + tesseract-wasm + result panel
│   ├── popup/                  # Six modes, PDF/subtitle/ASR entry points
│   ├── options/                # General/Services/Glossary/Site rules/PDF/Image/Subtitle/ASR/Gateway/Feedback…
│   ├── providers/              # Optional translateStream / translateImage / transcribe
│   ├── storage/                # settings schema v6 + migrations + cache + feedback + taskTable
│   ├── messaging/messages.ts   # Protocol v6 (fully typed, backward-compatible with legacy messages)
│   ├── shared/                 # types/constants/binaryChunk/languageDetect/…
│   └── styles/
├── vendor/                     # pdf.js + tesseract.js + tessdata (SHA-256 verified at build time)
├── native-host/                # C#/.NET gateway 4.2.1 / protocol v2 (Ollama / HTTP / Whisper)
├── scripts/
│   ├── build.mjs               # Chrome/Edge dist/ + Firefox dist-firefox/
│   ├── manifest-firefox.mjs    # gecko.id + background.scripts event page
│   ├── smoke-test.mjs          # Headless Edge E2E smoke test (see `npm run smoke` output)
│   ├── gateway-contract-test.mjs
│   ├── gateway-ollama-check.mjs
│   └── load-edge-ollama.mjs    # Headed Edge + local Ollama manual integration script
├── tests/                      # vitest unit tests (see `npm run test` output)
└── docs/                       # VALIDATION-4.2, history/, FIREFOX-MV3, store/
```

## Development

Node.js 24 is recommended (see `engines` in `package.json` for supported ranges). Running full gateway verification requires Windows, the .NET 10 SDK, and the .NET 8 runtime (gateway tests target `net8.0`).

```bash
npm ci
npm run build        # Produces dist/ and dist-firefox/
npm run typecheck    # tsc --noEmit (strict)
npm run test         # vitest (see `npm run test` output)
npm run smoke        # Headless Edge E2E smoke test (requires build; includes gateway install/uninstall)
npm run verify       # typecheck + test + build + gateway xUnit
npm run test:contract # Gateway stdio contract against the current commit
npm run verify:all   # verify + stdio contract + Edge smoke (excludes Firefox)

# Gateway
dotnet build native-host/PolyPage.slnx
dotnet test  native-host/PolyPage.slnx                     # see command output
```

Load the extension:

- Chrome / Edge: `chrome://extensions` (`edge://extensions` on Edge) → Developer mode → **Load unpacked** → select `dist/`.
- Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on…** → select `dist-firefox/manifest.json`. See `docs/FIREFOX-MV3.md` for capability differences.

> Official Chrome's headless mode ignores `--load-extension`, so smoke tests run against Edge.  
> When connecting directly to a local Ollama instance, set `OLLAMA_ORIGINS=*` (or `chrome-extension://*` / `moz-extension://*`), then quit Ollama from the system tray and restart it; otherwise requests from the extension Origin return HTTP 403.

## Configuring translation services

Options → **Translation Services** → **Add Service**; choosing a preset populates the service endpoint automatically. Services that expose a model list allow entering your API Key and clicking **Fetch Models**, then selecting a model and saving. You can also enter a model ID manually or add a custom OpenAI-compatible endpoint. Multiple providers can coexist, and you can select an active provider and configure a **failover chain**.

- **openai-compatible**: `POST {baseUrl}/chat/completions`, supports SSE streaming, MiniMax Token Plan (`api.minimax.chat` / MiniMax-M3 vision), **vision translation (`image_url`)**, and **`/audio/transcriptions` transcription**; local endpoints do not require an API Key.
- **OpenCode Go**: uses a personal API Key from a subscribed workspace. Quota displays remaining 5-hour, weekly, and monthly percentages with reset times, and can be queried manually or refreshed automatically every 15 minutes while the browser is running. OpenCode Go primarily targets coding clients; translation compatibility should be verified via the connection test. [OpenCode Go documentation](https://opencode.ai/docs/console/go/#where-can-i-use-it)
- **deepl / azure-translator / google-translate**: uses each provider's official endpoint and authentication.
- **custom-http**: configurable body template + response path.
- **native-host**: routes to Ollama / HTTP / Whisper through the local .NET gateway. Legacy protocol 1 gateways gray out vision and ASR instead of throwing.

If a Provider does not support an optional capability, its corresponding UI entry point is disabled with a clear reason rather than falling back silently through an alternative path.

Prompt template variables: `{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`.

## Entry points

- **PDF**: Popup **Open Bilingual Reader** (shown when a PDF is detected) / context menu **Open Bilingual Reader with PolyPage** / link context menu; Options can enable **Auto-open when visiting PDF links** (requires granting `webNavigation`). Scanned pages show a **Recognize this page** action beside the notice (runs through the active OCR engine).
- **Images**: Image context menu **Translate Image Text**, or hover over large images to click the **Translate Image** button in the top-right corner. `llm-vision` requires a vision Provider; `tesseract-wasm` lets text-only models recognize text first and then translate it.
- **Subtitles**: On video pages with `<track>`, toggle **Subtitle Translation** in the Popup; toggle again to restore original subtitles.
- **Subtitle-free media**: Popup / context menu **Transcribe & Translate**; captures a finite window from the current playback position by default, with secondary confirmation for full-media transcription. In-memory cues are discarded on close. Does not request microphone permission.
- **Text selection**: Selecting text shows a floating button; the panel supports read-aloud (`Alt+Click` reads source text), flagging bad sentences, and copying; `Alt+Q` repeats the last selection.
- **Feedback**: Hover a bilingual block / subtitle cue / PDF block and click **Flag bad sentence**; export from Options → **Feedback Log**.

## Architecture highlights

- **Unified background pipeline**: Web pages, PDFs, image OCR, subtitle cues, and ASR output all share the same queue / batching / cache / failover / error-classification pipeline; content scripts and viewer pages have zero direct API contact.
- **User-triggered first**: Automatic full-video transcription is prohibited; images and scanned pages only react to user clicks. Lazy per-page PDF translation after opening the reader is bounded by viewport and concurrency limits.
- **Non-destructive**: Never modifies source PDFs, source video/subtitle files, or writes back to SRT/VTT. Restoring web pages is reversible at the text/markup structure level (removing translated chrome and `data-wt-id`), not byte-identical DOM equality; `inline` mode stores originals via `cloneNode`, so restore does not reattach event listeners or framework bindings.
- **Message protocol v6** (`src/messaging/messages.ts`): legacy messages remain supported.
- **Resume**: Task table tracks in-flight web/PDF tasks; ASR never enters the 3.0 resume table and is cleaned up when the tab closes.
- **Sensitive data**: API Keys live only in background storage or the local gateway; no additional mandatory permissions and no microphone permission.

## Verification

- Regular CI runs `npm ci`, `npm run verify`, and `npm run test:contract` on Windows.
- Before release, manually trigger [Browser validation](.github/workflows/browser-validation.yml) in GitHub Actions. Confirm both jobs run against the exact release candidate commit: Edge executes the full E2E smoke test, while Firefox temporarily loads the extension and completes a local stub translation through the gateway built from the same commit. Both jobs run on clean hosted runners without real providers, keys, or Whisper weights.
- Running `npm run smoke` locally temporarily registers and unregisters the test gateway; full Windows browser validation should prefer the hosted runners above.
- See [4.2 sign-off notes](docs/VALIDATION-4.2.md) for historical release validation and known gaps.

## Known limitations

- Two-column / table clustering in PDFs remains heuristic and does not guarantee perfect layout preservation;
- No Provider currently implements `transcribeStream`, so ASR injects subtitles in one batch after transcription completes; in-memory cues are discarded on close and are not exported as SRT/VTT;
- DRM or media unable to use `captureStream` raises an error and refuses to download the full file; entry points are not pre-disabled by DRM detection, and neither `tabCapture` nor microphone permissions are requested;
- `subtitleSelectors` are rule-driven and break when sites change their DOM (built-in YouTube rules update with extension releases);
- `tesseract` bundles `eng` + `chi_sim` by default; extra language packs can be downloaded in Options;
- **Translated-only mode** replaces paragraphs with plain text (bilingual / inline modes preserve markup structure);
- Closed Shadow DOMs cannot be traversed (browser restriction);
- Firefox runs as a temporary loadable add-on and degrades cleanly when the Native Host is unavailable. Safari, mobile browsers, and AMO store publishing are outside the 4.2 scope.

## 4.3 candidate roadmap

Proceed in the order below only after 4.2 release verification passes. All items below are pending work items, not 4.2 delivery commitments.

| Order | Scope | Acceptance criteria |
|---|---|---|
| 1 | Real Whisper integration | Use a fixed short audio clip, user-installed weights, and the Windows gateway; record backend, model version, and commands, and verify timestamps, bilingual cues, and cleanup after close using real transcription. If weights are unavailable, mark explicitly as unverified rather than substituting stubs. |
| 2 | `<audio>`-only subtitle bar | Reuse the existing cue scheduler; cover play, seek, close, and switching media sources, and verify no regression on existing video subtitles. |
| 3 | SRT export | Export only current cues explicitly triggered by the user; verify timestamp ordering, Unicode, and formatting without modifying source media or subtitles. |
| 4 | Complex PDF layouts | Add real table and two-column fixtures first; verify segments do not bleed across cells while retaining line-level fallback. |

Streaming ASR will be scoped only after an actual backend provides `transcribeStream`, preserving user-triggered capture, no microphone permissions, and not bundling Whisper weights with the extension.
