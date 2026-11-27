# PolyPage — Web Translator Extension

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [日本語](README.ja.md)

[![CI](https://github.com/Skymly/PolyPage/actions/workflows/ci.yml/badge.svg)](https://github.com/Skymly/PolyPage/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Skymly/PolyPage?label=Release)](https://github.com/Skymly/PolyPage/releases)

支援 Chrome、Edge 與 Firefox 的 Manifest V3 雙語網頁翻譯瀏覽器擴充功能（TypeScript + 選用 C#/.NET 本機閘道）。

串接您自己的 **LLM / 翻譯 API / 本機模型**，在網頁、PDF、圖片、影片字幕與無字幕影音內容上取得翻譯：

- 原文 / 譯文 / 雙語對照 / **段內 inline 對照** 等六種網頁顯示模式；
- **PDF 雙語閱讀器**：擴充功能內建閱讀器頁面（本機 pdf.js），支援逐頁文字分群、依頁延遲翻譯、文件指紋快取（重複開啟零 API 呼叫），掃描頁可依目前 OCR 引擎辨識；
- **圖片文字翻譯（OCR）**：右鍵選單 / 懸停按鈕觸發；多模態視覺一步翻譯，或透過 **`tesseract-wasm` 本機辨識後再走文字管線**；Shadow DOM 結果面板；
- **影片字幕翻譯**：接管 `<track>` 字幕，自繪雙語字幕層；`subtitleSelectors` 站點規則適配自繪字幕網站（如 YouTube）；
- **無字幕影片 / 音訊 ASR**：使用者點擊後自目前播放位置擷取有限視窗，轉寫為記憶體 cue，並複用同一字幕層進行翻譯與還原（預設不自動轉寫整段）；
- **選字翻譯 + 朗讀**、`Alt+Q` 重複上次選字翻譯、**標記不良譯句回饋日誌**（CSV/JSON 匯出）；
- **頁面語言自動偵測**（本機零相依性 12 種語言）：`auto` 來源語言填入 + 同語言自動翻譯防護；
- **續譯**：背景工作表持續化儲存（IndexedDB），Service Worker 重啟後依分頁復原進行中任務（快取冪等）；
- 相容 **Shadow DOM / iframe（同源 + 跨源）/ 站點規則 / 虛擬清單檢視區翻譯**；
- 內建 **DeepL / Azure Translator / Google Translate / Ollama / Whisper 閘道** 預設組態與容錯移轉鏈；
- **本機 .NET 閘道（Native Messaging Host）**：選用相依性，通訊協定 v2 支援圖片 / 轉寫 / 分塊傳輸；
- 術語表、雙語匯出、翻譯快取、批次合併、逾時/重試、錯誤分類與日誌。

> 目前規格以 `PolyPage-4.2.md` 與 `docs/VALIDATION-4.2.md` 為準。已完成的 1.0–4.1 規劃與驗證紀錄位於 `docs/history/`。Firefox 差異請參閱 `docs/FIREFOX-MV3.md`；商店上架資料位於 `docs/store/`。

<details>
<summary>版本演進重點（4.0 – 4.2）</summary>

- **4.2**（`PolyPage-4.2.md`）：統一剝離 `<think>` / qwen3 殘留片段（剝空視為失敗且不寫入快取/TM）、以隔離 profile + Marionette 驗證 Firefox `host-status` 與 native-host 翻譯、依實際能力閘控串流 cue、捲動重算覆蓋層及 PDF 表格夾具。設定 `schemaVersion: 6`，通訊協定 `v: 6`，閘道 `4.2.1`（`ProtocolVersion = 2`）。
- **4.1**（`docs/history/PolyPage-4.1.md`）：預設關閉的獨立 IndexedDB 句子 TM（5000 筆環狀緩衝）、於 Options 下載 `tessdata_fast` OCR 語言包（`jpn`/`kor`/`fra`/`deu`）、Firefox `connectNative` ping 與翻譯探測、PDF 單欄/雙欄/表格預設模式（`schemaVersion: 5`）。
- **4.0**（`docs/history/PolyPage-4.0.md`）：使用者觸發的無字幕影音擷取（預設 90 秒視窗）與閘道 Whisper 編排、多模態 `translate.image` / `transcribe` / `binary.chunk` 通訊協定 v2、內建 `tesseract-wasm`（`eng` + `chi_sim`）及 `dist-firefox/` MVP（`schemaVersion: 4`）。

</details>

## 目錄結構

```text
├── public/
│   ├── icons/                  # 建置指令碼產生的圖示
│   └── manifest.json           # MV3 清單 4.2.1（選用 webNavigation，無麥克風）
├── src/
│   ├── background/             # service-worker + nativePort（佇列/容錯移轉/OCR/ASR/續譯）
│   ├── content/                # 網頁翻譯 + 字幕層 + 選字 + 圖片按鈕 + ASR 擷取
│   ├── asr/                    # ★ 轉寫切段（具 segments / 純文字均分）
│   ├── viewer/                 # PDF 雙語閱讀器（含掃描頁 OCR）
│   ├── ocr/                    # OcrEngine + llm-vision + tesseract-wasm + 結果面板
│   ├── popup/                  # 六模式、PDF/字幕/ASR 入口
│   ├── options/                # 一般/服務/術語表/站點規則/PDF/圖片/字幕/ASR/閘道/回饋…
│   ├── providers/              # 選用 translateStream / translateImage / transcribe
│   ├── storage/                # settings schema v6 + 遷移 + cache + feedback + taskTable
│   ├── messaging/messages.ts   # 通訊協定 v6（全量型別化，相容舊訊息）
│   ├── shared/                 # types/constants/binaryChunk/languageDetect/…
│   └── styles/
├── vendor/                     # pdf.js + tesseract.js + tessdata（建置期 SHA-256 校驗）
├── native-host/                # C#/.NET 閘道 4.2.1 / 通訊協定 v2（Ollama / HTTP / Whisper）
├── scripts/
│   ├── build.mjs               # Chrome/Edge dist/ + Firefox dist-firefox/
│   ├── manifest-firefox.mjs    # gecko.id + background.scripts 事件頁
│   ├── smoke-test.mjs          # 無頭 Edge 端對端冒煙（見 `npm run smoke` 輸出）
│   ├── gateway-contract-test.mjs
│   ├── gateway-ollama-check.mjs
│   └── load-edge-ollama.mjs    # headed Edge + 本機 Ollama 手動聯調
├── tests/                      # vitest 單元測試（見 `npm run test` 輸出）
└── docs/                       # VALIDATION-4.2、history/、FIREFOX-MV3、store/
```

## 開發

建議使用 Node.js 24（支援範圍見 `package.json` 的 `engines`）。執行完整閘道驗證需要 Windows、.NET 10 SDK 與 .NET 8 執行階段（閘道測試目標為 `net8.0`）。

```bash
npm ci
npm run build        # 產出 dist/ 與 dist-firefox/
npm run typecheck    # tsc --noEmit（strict）
npm run test         # vitest（見指令輸出）
npm run smoke        # 無頭 Edge 端對端冒煙（需已建置；含閘道安裝/解除安裝）
npm run verify       # typecheck + test + build + 閘道 xUnit
npm run test:contract # 目前提交的閘道 stdio 契約
npm run verify:all   # verify + stdio 契約 + Edge smoke（不含 Firefox）

# 閘道
dotnet build native-host/PolyPage.slnx
dotnet test  native-host/PolyPage.slnx                     # 見指令輸出
```

載入擴充功能：

- Chrome / Edge：`chrome://extensions`（Edge 為 `edge://extensions`）→ 開發人員模式 → **載入未封裝項目**，選擇 `dist/`。
- Firefox：`about:debugging` → 本機 Firefox → **載入暫時附加元件** → 選擇 `dist-firefox/manifest.json`。能力降級請參閱 `docs/FIREFOX-MV3.md`。

> 正式版 Chrome 的無頭模式會忽略 `--load-extension`，因此冒煙測試採用 Edge。  
> 直連本機 Ollama 時請設定 `OLLAMA_ORIGINS=*`（或 `chrome-extension://*` / `moz-extension://*`）後自系統匣結束並重新啟動 Ollama；否則擴充功能 Origin 將收到 HTTP 403。

## 組態翻譯服務

設定頁 → **「翻譯服務」** → **「新增服務」**，選擇預設項會自動填入服務位址。支援模型清單的服務可填入 API Key 後點擊 **「取得模型清單」**，再選取模型並儲存。亦可手動輸入模型 ID，或新增自訂 OpenAI 相容介面。多個 Provider 可共存，可選擇目前使用服務並組態**容錯移轉鏈**。

- **openai-compatible**：`POST {baseUrl}/chat/completions`，支援 SSE 串流、MiniMax Token Plan（`api.minimax.chat` / MiniMax-M3 視覺）、**視覺翻譯（`image_url`）** 與 **`/audio/transcriptions` 轉寫**；本機端點免 API Key。
- **OpenCode Go**：使用已訂閱工作區的個人 API Key。訂閱額度會顯示 5 小時、每週與每月的剩餘百分比及重設時間，可立即查詢，亦可在瀏覽器執行期間每 15 分鐘自動重新整理。OpenCode Go 官方主要面向程式設計用戶端，翻譯請求的可用性請以連線測試為準。[OpenCode Go 官方說明](https://opencode.ai/docs/console/go/#where-can-i-use-it)
- **deepl / azure-translator / google-translate**：各自使用官方端點與驗證機制。
- **custom-http**：Body 範本 + 回應路徑。
- **native-host**：經本機 .NET 閘道路由至 Ollama / HTTP / Whisper。通訊協定 1 舊版閘道會反灰視覺與 ASR 入口，不會拋出例外。

若某個 Provider 不支援特定選用能力，對應入口會反灰並顯示原因，不另開旁路。

Prompt 範本變數：`{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`。

## 使用入口

- **PDF**：Popup **「開啟雙語閱讀器」**（偵測到 PDF 時出現）/ 右鍵 **「以 PolyPage 開啟雙語閱讀器」** / 連結右鍵選單；設定可開啟「造訪 PDF 連結時自動開啟」（需授與 `webNavigation` 權限）。掃描頁提示旁可點擊 **「辨識本頁」**（使用目前 OCR 引擎）。
- **圖片**：圖片右鍵 **「翻譯圖片文字」**，或懸停於大圖右上角點擊 **「譯圖」** 按鈕。`llm-vision` 需要視覺 Provider；`tesseract-wasm` 可在純文字模型上先辨識再翻譯。
- **字幕**：含 `<track>` 的影片頁面，使用 Popup **「字幕翻譯」** 開關；再次點擊可還原原始字幕。
- **無字幕媒體**：Popup / 右鍵 **「轉寫並翻譯」**；預設自目前播放位置擷取有限視窗，整段轉寫需二次確認。關閉即丟棄記憶體 cue，不會要求麥克風權限。
- **選字**：選取文字後顯示浮動按鈕；面板支援朗讀（`Alt+點擊` 朗讀原文）、標記不良譯句與複製；`Alt+Q` 可重複上一次選字。
- **回饋**：懸停於雙語區塊 / 字幕層 / PDF 區塊點擊 **「標記不良譯句」**；可於 Options → **「回饋日誌」** 匯出。

## 架構重點

- **統一背景管線**：網頁、PDF、圖片 OCR、字幕 cue 與 ASR 產物皆複用同一套佇列 / 批次 / 快取 / 容錯移轉 / 錯誤分類管線；內容指令碼與檢視器頁面零 API 接觸。
- **使用者觸發優先**：禁止自動轉寫整頁影片；圖片與掃描頁僅回應使用者點擊。PDF 閱讀器開啟後的依頁延遲翻譯受檢視區與並行數限制。
- **不破壞原始內容**：不修改 PDF 原始檔案、不修改影片來源與字幕檔案、不寫回 SRT/VTT。網頁翻譯的還原屬於文字/標記結構層級可逆（移除譯文 chrome 與 `data-wt-id`），非逐位元組 DOM 等價；`inline` 模式以 `cloneNode` 保存原文，還原時不復原事件監聽器與框架繫結。
- **訊息通訊協定 v6**（`src/messaging/messages.ts`）：舊版訊息仍可相容處理。
- **續譯**：任務表紀錄進行中的網頁/PDF 任務；ASR 不進入 3.0 續譯表，關閉分頁即清理。
- **敏感資訊**：API Key 僅儲存於背景或本機閘道；無新增必要權限，不要求麥克風權限。

## 驗證

- 常規 CI 在 Windows 執行 `npm ci`、`npm run verify` 與 `npm run test:contract`。
- 發布前於 GitHub Actions 手動執行 [Browser validation](.github/workflows/browser-validation.yml)。核對兩個工作皆執行於待發布提交：Edge 執行完整冒煙測試，Firefox 暫時載入擴充功能，並透過同一提交編譯出的閘道完成一次本機樁翻譯。兩個工作各自使用獨立託管 runner，不需要真實 Provider、金鑰或 Whisper 權重。
- 本機執行 `npm run smoke` 會暫時註冊並解除安裝測試閘道；完整 Windows 瀏覽器驗證優先於上述託管 runner 上執行。
- 歷史發布驗證與已知缺口請參閱 [4.2 收斂紀錄](docs/VALIDATION-4.2.md)。

## 已知限制

- PDF 雙欄 / 表格分群仍採用啟發式演算法，不保證完美保留版面；
- 目前尚無 Provider 實作 `transcribeStream`，因此 ASR 於轉寫結束後一次注入字幕；關閉即丟棄記憶體 cue，不匯出 SRT/VTT；
- DRM 或無法使用 `captureStream` 的媒體會回報錯誤並拒絕下載整段檔案；不會預先依 DRM 反灰入口，亦不要求 `tabCapture` 或麥克風權限；
- `subtitleSelectors` 為規則驅動，網站改版即可能失效（內建 YouTube 規則隨版本更新）；
- tesseract 預設僅封裝 `eng` + `chi_sim`；附加語言包可於 Options 下載；
- 「譯文模式」會將段落整體替換為純文字（雙語/段內模式則保留標記結構）；
- 無法進入 closed Shadow DOM（瀏覽器限制）；
- Firefox 可暫時載入，Native Host 無法使用時會降級。Safari、行動端與 AMO 上架不在 4.2 範圍內。

## 4.3 候選路線圖

請先通過 4.2 發布驗證，再依下表順序推進。以下皆為待實作事項，並非 4.2 的交付承諾。

| 順序 | 範圍 | 驗收條件 |
|---|---|---|
| 1 | 真實 Whisper 聯調 | 使用固定短音訊、使用者自備權重與 Windows 閘道；記錄後端、模型版本與指令，以真實轉寫驗證時間戳記、雙語 cue 與關閉後清理。無權重時明確標記為未驗證，不可用樁替代。 |
| 2 | 純 `<audio>` 字幕列 | 複用現有 cue 排程；涵蓋播放、跳轉、關閉與切換音源，並驗證既有影片字幕不發生回歸。 |
| 3 | SRT 匯出 | 僅匯出使用者主動觸發的目前 cue；驗證時間順序、Unicode 與格式，不改寫媒體或來源字幕。 |
| 4 | PDF 複雜版面 | 先補齊真實表格與雙欄夾具；驗證不跨儲存格串段，並保留依行回退能力。 |

串流 ASR 將於實際後端提供 `transcribeStream` 後再立項；並持續保留使用者觸發、不要求麥克風、不隨擴充功能分發 Whisper 權重的約束。
