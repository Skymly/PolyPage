# PolyPage — Web Translator Extension

网页翻译浏览器插件 **4.0.0**（Chrome / Edge 发行主线，Firefox MV3 可加载 MVP；Manifest V3，TypeScript + C#/.NET 本地网关）。

接入你自己的 **LLM / 翻译 API / 本地模型**，在网页、PDF、图片、视频字幕和无字幕音视频上获得翻译：

- 原文 / 译文 / 双语对照 / **段内 inline 对照** 等六种网页显示模式；
- **PDF 双语阅读器**：扩展内阅读器页（本地 pdf.js），逐页文本聚类、按页惰性翻译、
  文档指纹缓存（重复打开零 API 调用）、扫描页可按当前 OCR 引擎识别；
- **图片文字翻译（OCR）**：右键 / 悬停按钮触发；多模态视觉一步翻译，或
  **tesseract-wasm 本地识别后再走文本管线**；Shadow DOM 结果面板；
- **视频字幕翻译**：接管 `<track>` 字幕，自绘双语字幕层；`subtitleSelectors`
  站点规则适配自绘字幕站点（如 YouTube）；
- **无字幕视频 / 音频 ASR**：用户点击后从当前播放位置采集有限窗口，转写成内存 cue，
  复用同一字幕层翻译与还原（默认不自动转写整段）；
- **划词翻译 + 朗读**、Alt+Q 重复上次划词、**标记坏句反馈日志**（CSV/JSON 导出）；
- **页面语言自动检测**（本地零依赖 12 语言）：auto 源语言填充 + 同语言自动翻译守护；
- **续译**：后台任务表持久化（IndexedDB），SW 重启后按 tab 恢复在途任务（缓存幂等）；
- **Shadow DOM / iframe（同源+跨源）/ 站点规则 / 虚拟列表视口翻译** 兼容；
- **DeepL / Azure Translator / Google Translate / Ollama / Whisper 网关** 预设与故障转移链；
- **本地 .NET 网关（Native Messaging Host）**：可选依赖，协议 v2 支持图片 / 转写 / 分块；
- 术语表、双语导出、翻译缓存、批量合并、超时/重试、错误分类与日志。

> 本项目按 `PolyPage.md`（1.0）、`PolyPage-2.0.md`、`PolyPage-3.0.md` 与
> `PolyPage-4.0.md` 实现。验证记录见 `docs/VALIDATION-2.0.md`、
> `docs/VALIDATION-3.0.md` 与 `docs/VALIDATION-4.0.md`。Firefox 差异见
> `docs/FIREFOX-MV3.md`；商店材料在 `docs/store/`。

---

## 4.0 新特性（对照 PolyPage-4.0.md）

3.0 的网页六模式、PDF / 图片 / 有字幕视频与体验收口全部保留。4.0 增量：

| 支柱 | 能力 |
|---|---|
| I 语音与无字幕视频 | 用户触发采集（默认 90 秒窗口，整段二次确认）；`Provider.transcribe` 或网关 Whisper；结果切成内存 cue，复用 3.0 字幕层；有 `<track>` 的视频不默认走 ASR |
| J 网关多模态 | 协议 v2（只增不改）：`translate.image` / `transcribe` / `binary.chunk`；capabilities 增加 `supportsVision` / `supportsAsr`；`WhisperBackend` 编排用户自装的 whisper.cpp / faster-whisper，不内嵌权重 |
| K 离线与质量 | 真实 tesseract-wasm（eng + chi_sim 本地打包）；扫描 PDF「识别本页」走当前 `OcrEngine`；字幕上下对调 / 背景 / 垂直位置；schema v4（v3→v4 只补默认值） |
| L 可分发 | `dist-firefox/` 可临时加载；安装器写 Mozilla Native Messaging 键；`docs/store` 隐私 / 权限 / listing 草稿。AMO 上架不是 4.0 退出条件 |

消息协议标记 `v: 4`（v1–v3 兼容）。设置 `schemaVersion: 4`。网关 `4.0.0`，`ProtocolVersion = 2`。

顺延 4.1（见 `docs/VALIDATION-4.0.md` §8）：句子级 TM 查表、OCR 附加语言包下载器、ASR 流式 cue、Firefox 网关真联调、图片原位覆盖、PDF 双栏/表格聚类专项。

## 目录结构

```text
├── public/
│   ├── icons/                  # 构建脚本生成的图标
│   └── manifest.json           # MV3 清单 4.0.0（可选 webNavigation，无麦克风）
├── src/
│   ├── background/             # service-worker + nativePort（队列/failover/OCR/ASR/续译）
│   ├── content/                # 网页翻译 + 字幕层 + 划词 + 图片按钮 + ASR 采集
│   ├── asr/                    # ★ 转写切段（有 segments / 纯文本均分）
│   ├── viewer/                 # PDF 双语阅读器（含扫描页 OCR）
│   ├── ocr/                    # OcrEngine + llm-vision + tesseract-wasm + 结果面板
│   ├── popup/                  # 六模式、PDF/字幕/ASR 入口
│   ├── options/                # 常规/服务/术语表/站点规则/PDF/图片/字幕/ASR/网关/反馈…
│   ├── providers/              # 可选 translateStream / translateImage / transcribe
│   ├── storage/                # settings schema v4 + 迁移 + cache + feedback + taskTable
│   ├── messaging/messages.ts   # 协议 v4（全量类型化，v1–v3 兼容）
│   ├── shared/                 # types/constants/binaryChunk/languageDetect/…
│   └── styles/
├── vendor/                     # pdf.js + tesseract.js + tessdata（构建期 SHA-256 校验）
├── native-host/                # C#/.NET 网关 4.0.0 / 协议 v2（Ollama / HTTP / Whisper）
├── scripts/
│   ├── build.mjs               # Chrome/Edge dist/ + Firefox dist-firefox/
│   ├── manifest-firefox.mjs    # gecko.id + background.scripts 事件页
│   ├── smoke-test.mjs          # 无头 Edge 端到端冒烟（111 项断言）
│   ├── gateway-contract-test.mjs
│   ├── gateway-ollama-check.mjs
│   └── load-edge-ollama.mjs    # headed Edge + 本地 Ollama 手动联调
├── tests/                      # vitest 单元测试（188 个）
└── docs/                       # VALIDATION-2.0/3.0/4.0、FIREFOX-MV3、store/
```

## 开发

```bash
npm install
npm run build        # 产出 dist/ 与 dist-firefox/
npm run typecheck    # tsc --noEmit（strict）
npm run test         # vitest 单元测试（188）
npm run smoke        # 无头 Edge 端到端冒烟（需已构建；含网关安装/卸载）
npm run verify       # typecheck + test + build
npm run verify:all   # verify + 网关 xunit + stdio 契约 + smoke

# 网关
dotnet build native-host/PolyPage.slnx
dotnet test  native-host/PolyPage.slnx                     # 32 个契约测试
node scripts/gateway-contract-test.mjs                     # 真实进程 stdio 协议测试
```

加载扩展：

- Chrome / Edge：`chrome://extensions`（Edge 为 `edge://extensions`）→ 开发者模式 →
  「加载已解压的扩展」选择 `dist/`。
- Firefox：`about:debugging` → 此 Firefox → 临时载入附加组件 → 选择
  `dist-firefox/manifest.json`。能力降级见 `docs/FIREFOX-MV3.md`。

> 正版 Chrome 的无头模式忽略 `--load-extension`，因此冒烟测试使用 Edge。
> 直连本地 Ollama 时请设置 `OLLAMA_ORIGINS=*`（或 `chrome-extension://*` /
> `moz-extension://*`）后从托盘退出并重启 Ollama；否则扩展 Origin 会得到 HTTP 403。

## 配置翻译服务

设置页 → 「翻译服务」。**从预设创建**后通常只需填 API Key。多个 Provider 可共存，
单选当前生效；另可配置**故障转移链**。

- **openai-compatible**：`POST {baseUrl}/chat/completions`，支持 SSE 流式、
  **视觉翻译（image_url）** 与 **`/audio/transcriptions` 转写**；本地端点免 API Key。
- **deepl / azure-translator / google-translate**：各自官方端点与鉴权。
- **custom-http**：Body 模板 + 响应路径。
- **native-host**：经本地 .NET 网关路由到 Ollama / HTTP / Whisper。协议 1 旧网关
  会置灰视觉与 ASR，不抛错。

不支持某项可选能力的 Provider，对应入口置灰并给出原因，不另开旁路。

Prompt 模板变量：`{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`。

## 使用入口

- **PDF**：Popup「打开双语阅读器」（检测到 PDF 时出现）/ 右键「用 PolyPage 打开双语阅读器」/
  链接右键；设置可开「访问 PDF 链接自动打开」（需授予 webNavigation）。扫描页提示旁可
  「识别本页」（走当前 OCR 引擎）。
- **图片**：图片右键「翻译图片文字」或悬停大图右上角「译图」按钮。`llm-vision` 需要
  视觉 Provider；`tesseract-wasm` 可在纯文本模型上先识别再翻译。
- **字幕**：带 `<track>` 的视频页，Popup「字幕翻译」开关；再按一次还原原字幕。
- **无字幕媒体**：Popup / 右键「转写并翻译」；默认从当前播放位置起有限窗口，整段需二次确认。
  关闭即丢弃内存 cue。不申请麦克风。
- **划词**：选中文字出悬浮按钮；面板支持朗读（Alt+点击读原文）、标记坏句、复制；
  Alt+Q 重复上一次划词。
- **反馈**：双语块 / 字幕层 / PDF 块悬停「标记坏句」；Options →「反馈日志」导出。

## 架构要点

- **统一后台管线**：网页、PDF、图片 OCR、字幕 cue 与 ASR 产物全部复用同一
  队列 / 批量 / 缓存 / failover / 错误分类管线；内容脚本与视图页零 API 接触。
- **用户触发优先**：禁止自动转写整页视频；图片 / 扫描页只响应用户点击。
  PDF 阅读器打开后的按页惰性翻译受视口与并发限制。
- **不破坏原始内容**：不改 PDF 源文件、不改视频源与字幕文件、不写回 SRT/VTT。
- **消息协议 v4**（`src/messaging/messages.ts`）：在 v3 上增加 ASR / 扫描页 OCR 等命令；
  旧消息仍可处理。
- **续译**：任务表记录在途网页/PDF 任务；ASR 不入 3.0 续译表。tab 关闭即清理。
- **敏感信息**：API Key 只存后台或本机网关；无新增必选权限，不申请麦克风。

## 验证

- `npm run typecheck`：strict TypeScript 零错误；
- `npm run test`：**188 个单元测试**（3.0 的 163 个全部保留 + 4.0：schema v3→v4、
  ASR 切段、tesseract 两步法、扫描页缓存键、字幕样式、分块 sha256、
  openai-compatible `transcribe`、本地 Ollama 403 提示）；
- `npm run smoke`：无头 Edge 加载真实扩展，**111 项端到端断言**（3.0 的 103 项
  零回退 + 无字幕转写内存 cue / 有 track 不自动 ASR / 扫描页「识别本页」按钮 /
  schema 落盘为 v4）；
- `dotnet test` + `gateway-contract-test.mjs`：**32 + 扩展后的 stdio 契约**
  （旧 28+9 原样保留，协议升为 v2）；
- 手动联调清单记录于 `docs/VALIDATION-4.0.md`。

## 已知限制

- PDF 双栏 / 表格聚类仍为启发式，不承诺完美版面；
- ASR 一次转写结束后再出字幕，不边转写边出；关闭即丢内存 cue，不导出 SRT/VTT；
- DRM / 无法 `captureStream` 且无法同源 fetch 的媒体入口置灰；不申请 tabCapture 或麦克风；
- `subtitleSelectors` 为规则驱动，站点改版即失效（内置 YouTube 规则随版本更新）；
- tesseract 默认只打包 `eng` + `chi_sim`；附加语言包下载器顺延 4.1；
- 「译文模式」段落整体替换为纯文本（双语/段内模式保留标记结构）；
- closed Shadow DOM 无法进入（浏览器限制）；
- Firefox 是可加载 MVP：网页六模式 + 划词必须可用；Native Host / PDF / ASR 允许降级。
  Safari / 移动端 / AMO 上架不在 4.0 范围。
