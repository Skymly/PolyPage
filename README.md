# PolyPage — Web Translator Extension

网页翻译浏览器插件 **3.0**（Chrome / Edge，Manifest V3，TypeScript + C#/.NET 本地网关）。

接入你自己的 **LLM / 翻译 API / 本地模型**，在**网页、PDF、图片、视频字幕**四大载体上获得翻译：

- 原文 / 译文 / 双语对照 / **段内 inline 对照** 等六种网页显示模式；
- **PDF 双语阅读器**：扩展内阅读器页（本地 pdf.js），逐页文本聚类、按页惰性翻译、
  文档指纹缓存（重复打开零 API 调用）、扫描页明确提示；
- **图片文字翻译（OCR）**：右键 / 悬停按钮触发，多模态视觉一步翻译为
  「原文片段 + 译文」结构化结果，Shadow DOM 结果面板；
- **视频字幕翻译**：接管 `<track>` 字幕，自绘双语字幕层；`subtitleSelectors`
  站点规则适配自绘字幕站点（如 YouTube）；
- **划词翻译 + 朗读**、Alt+Q 重复上次划词、**标记坏句反馈日志**（CSV/JSON 导出）；
- **页面语言自动检测**（本地零依赖 12 语言）：auto 源语言填充 + 同语言自动翻译守护；
- **续译**：后台任务表持久化（IndexedDB），SW 重启后按 tab 恢复在途任务（缓存幂等）；
- **Shadow DOM / iframe（同源+跨源）/ 站点规则 / 虚拟列表视口翻译** 兼容；
- **DeepL / Azure Translator / Google Translate / Ollama** 预设与故障转移链；
- **本地 .NET 网关（Native Messaging Host）**：可选依赖，凭据留在本机；
- 术语表、双语导出、翻译缓存、批量合并、超时/重试、错误分类与日志。

> 本项目按 `PolyPage.md`（1.0 规格）、`PolyPage-2.0.md`（2.0 规划）与
> `PolyPage-3.0.md`（3.0 规划）实现；验证记录见 `docs/VALIDATION-2.0.md`
> 与 `docs/VALIDATION-3.0.md`。

---

## 3.0 新特性（对照 PolyPage-3.0.md）

| 支柱 | 能力 |
|---|---|
| E PDF 双语阅读器 | `viewer/pdf-viewer.html` 扩展内阅读器（pdf.js 4.10 本地打包、构建期哈希校验、仅阅读器页懒加载）；textItem 行/段聚类（行距/字号/缩进/连字符/页眉页脚/页码过滤、双栏重排）；按页惰性翻译 + 视口预算（>2000 段降级视口±1）+ 文档级并发 ≤3；文档指纹缓存键；bilingual / 译文+悬停原文 / 仅原文；Popup 与右键入口、扫描页提示；可选 webNavigation 自动打开（optional_permissions） |
| F 图片 OCR 翻译 | `OcrEngine` 抽象 + `llm-vision` 引擎（多模态一步产出结构化片段）；Provider 可选能力 `translateImage`（不支持的服务入口置灰 + 原因提示）；右键菜单 + ≥200px 悬停按钮（**仅用户点击触发**）；后台取图 + 内容哈希缓存 + 降采样（4096px/8MB 上限，OffscreenCanvas）；Shadow DOM 结果面板（单条/全部复制、取消） |
| G 视频字幕翻译 | `<track>` 接管（mode=hidden，不删不改源）+ cuechange/timeupdate 双通道；自绘 Shadow DOM 字幕层（双语/仅译文/仅原文、字号可调、全屏跟随）；cue 缓存（重复字幕命中）；多视频按最近交互；关闭即还原零残留；站点规则 `subtitleSelectors` 就地翻译自绘字幕（内置 YouTube 规则） |
| H 体验收口 | 设置 schema v3（v2→v3 只补默认值、v3 可被 2.0 代码安全读取）；页面语言自动检测（script 分类 + 停用词投票，12 语言）；自动翻译同语言守护；质量反馈日志（环形 200，Options 查看/删除/CSV/JSON 导出）；划词朗读（speechSynthesis 按目标语言选声，能力探测置灰）；Alt+Q 重复划词；续译任务表（IndexedDB，5000 环形，tabs.onRemoved 清理，SW 重启恢复） |

消息协议升级为 v3（`v: 3` 标记，v1/v2 兼容），网关协议与 .NET 代码 3.0 零改动。

## 目录结构

```text
├── public/
│   ├── icons/                  # 构建脚本生成的图标
│   └── manifest.json           # MV3 清单（3.0：repeat-selection 命令、webNavigation 可选权限）
├── src/
│   ├── background/             # service-worker（队列/批量/failover/OCR 路由/续译/反馈/PDF 入口）+ nativePort
│   ├── content/                # scanner/translator/renderer/tooltip/observer/selection/inline/rules
│   │                           # + 3.0：media(字幕层)/imageButton/feedback/subtitleScheduler
│   ├── viewer/                 # ★ PDF 双语阅读器（pdf-viewer.html + main + pdf/loader + pdf/segment + pdf/fingerprint）
│   ├── ocr/                    # ★ OcrEngine 抽象 + llm-vision + tesseract(3.1) + resultPanel
│   ├── popup/                  # 六模式、多 frame 聚合、PDF/字幕入口、页面语言
│   ├── options/                # 常规/服务/术语表/站点规则/PDF/图片/字幕/反馈日志/网关…
│   ├── providers/              # provider 抽象（3.0 增加可选 translateImage 视觉能力）+ 六类实现 + presets
│   ├── storage/                # settings（schema v3 + 迁移）+ cache + feedback + taskTable(续译)
│   ├── messaging/messages.ts   # 协议 v3（全量类型化，v1/v2 兼容）
│   ├── shared/                 # types/constants/utils/textFilters/siteRules/languageDetect/imageUtils/…
│   └── styles/                 # content.css + tooltip.css（注入 Shadow DOM）
├── vendor/                     # ★ pdf.js 本地发行版（构建期 SHA-256 校验，scripts/vendor-hashes.json）
├── native-host/                # C#/.NET 网关解决方案（3.0 未改动）
├── scripts/
│   ├── build.mjs               # 6 段构建（popup/options/viewer/background/content/vendor 校验）
│   ├── sync-vendor.mjs         # pdf.js 升级后重钉 vendor 哈希
│   ├── smoke-test.mjs          # 无头 Edge 端到端冒烟（103 项断言）
│   ├── gateway-contract-test.mjs   # 真实网关 stdio 契约测试
│   └── gateway-ollama-check.mjs    # 真实 Ollama 经网关联调
├── tests/                      # vitest 单元测试（163 个）
└── docs/                       # VALIDATION-2.0.md / VALIDATION-3.0.md
```

## 开发

```bash
npm install
npm run build        # 产出 dist/（可直接加载的未打包扩展，含 vendor pdf.js 哈希校验）
npm run typecheck    # tsc --noEmit（strict）
npm run test         # vitest 单元测试（163）
npm run smoke        # 无头 Edge 端到端冒烟（需已构建；含网关安装/卸载）
npm run verify       # typecheck + test + build
npm run verify:all   # verify + 网关 xunit + stdio 契约 + smoke

# 网关（3.0 未改动）
dotnet build native-host/PolyPage.slnx
dotnet test  native-host/PolyPage.slnx                     # 28 个契约测试
node scripts/gateway-contract-test.mjs                     # 真实进程 stdio 协议测试
```

加载扩展：`chrome://extensions`（Edge 为 `edge://extensions`）→ 开发者模式 →
「加载已解压的扩展」选择 `dist/`。

> 注意：正版 Chrome 的无头模式忽略 `--load-extension`，因此冒烟测试使用 Edge。

## 配置翻译服务

设置页 → 「翻译服务」。**从预设创建**后通常只需填 API Key。多个 Provider 可共存，
单选当前生效；另可配置**故障转移链**。

- **openai-compatible**：`POST {baseUrl}/chat/completions`，支持 SSE 流式与
  **视觉翻译（image_url 载荷）**；本地端点免 API Key。图片翻译需要此类多模态服务。
- **deepl / azure-translator / google-translate**：各自官方端点与鉴权。
- **custom-http**：Body 模板 + 响应路径。
- **native-host**：经本地 .NET 网关路由到 Ollama / 企业 HTTP 服务。

Prompt 模板变量：`{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`。

## 3.0 使用入口

- **PDF**：Popup「打开双语阅读器」（检测到 PDF 时出现）/ 右键「用 PolyPage 打开双语阅读器」/
  链接右键；设置可开「访问 PDF 链接自动打开」（需授予 webNavigation）。
- **图片**：图片右键「翻译图片文字」或悬停大图右上角「译图」按钮；结果面板支持
  单条/全部复制与取消。当前 Provider 不支持视觉时入口置灰。
- **字幕**：带 `<track>` 字幕的视频页，Popup「字幕翻译」开关（作用于最近交互的视频）；
  再按一次还原原字幕。
- **划词**：选中文字出悬浮按钮；面板支持朗读（Alt+点击读原文）、标记坏句、复制；
  Alt+Q 重复上一次划词（无选区时重放结果面板）。
- **反馈**：双语块 / 字幕层 / PDF 块悬停「标记坏句」；Options →「反馈日志」导出。

## 架构要点

- **统一后台管线**：PDF 段落、图片 OCR、字幕 cue 与网页文本全部复用同一
  队列 / 批量 / 缓存 / failover / 错误分类管线（字幕走低延迟单条通道）；
  内容脚本与新视图页零 API 接触。
- **用户触发优先**：图片 / 视频 / PDF 一律不做全自动批量处理（唯一例外：
  PDF 阅读器打开后的按页惰性翻译，受视口与并发限制）。
- **不破坏原始内容**：不改 PDF 源文件、不改视频源与字幕文件、面板不入页面 DOM。
- **消息协议 v3**（`src/messaging/messages.ts` 全量类型化）：新增
  ocr-request/ocr-cancel、translate-cue、mark-feedback、pdf-open/pdf-progress、
  detect-language；TabCommand 新增 wt:open-pdf-viewer / wt:translate-image /
  wt:toggle-subtitles / wt:repeat-selection / wt:resume-inflight。
- **续译**：任务表记录在途任务，SW 重启后向存活 tab 广播恢复；已完成条目靠
  缓存幂等跳过；tab 关闭即清理，总量 5000 环形淘汰。

## 验证

- `npm run typecheck`：strict TypeScript 零错误；
- `npm run test`：**163 个单元测试**（2.0 的 83 个全部保留 + 3.0 新增：
  PDF 段落聚类/页码/页眉页脚/双栏/扫描页、文档指纹与缓存键稳定性、
  llm-vision 请求构造与响应解析（含畸形 JSON 归因）、图片降采样边界、
  cue 调度（激活/切换/缓存命中/失败冷却/还原）、语言检测器 12 语言样本、
  schema v2→v3 迁移与 v3→v2 读兼容、续译任务表持久化/幂等/环形淘汰、
  反馈日志环形上限与 CSV 导出）；
- `npm run smoke`：无头 Edge 加载真实扩展，**103 项端到端断言**（2.0 的 61 项
  零回退 + 语言检测/同语言守护/坏句反馈/Alt+Q 重放/图片 OCR 全流程与缓存/
  视觉置灰/字幕接管-切换-还原/本地伺服 PDF 全流程与二次打开零调用/
  SW 杀死后续译恢复/真实 .NET 网关与故障转移）；
- `dotnet test` + `gateway-contract-test.mjs`：**28 + 9 项网关契约全绿（3.0 未改网关代码）**；
- 手动联调清单记录于 `docs/VALIDATION-3.0.md`。

## 已知限制

- PDF 双栏 / 表格聚类为启发式（可调参 + 「按行」回退待 P2 优化），不承诺完美版面；
  扫描 PDF（无文本层）P0 仅提示，转视觉管线联动列入后续；
- 字幕翻译不覆盖无字幕视频（ASR 为 4.0 候选）；DRM 保护流只处理浏览器可读部分；
- `subtitleSelectors` 为规则驱动，站点改版即失效（内置 YouTube 规则随版本更新）；
- 「译文模式」段落整体替换为纯文本（双语/段内模式保留标记结构）；
- closed Shadow DOM 无法进入（浏览器限制）；
- Firefox / Safari / 移动端不在范围（见 PolyPage-3.0.md §4）。