# 项目规划文档：网页翻译浏览器插件 3.0

## 0. 给 Agent 的总指令

本文档是 **3.0 版本的规划文档**，基于 `PolyPage.md`（1.0 规格）与 `PolyPage-2.0.md`（2.0 规划）制定。
2.0 已交付并验证（strict TypeScript、83 单元测试、61 项无头浏览器端到端断言、
28 项 .NET 网关契约测试 + 9 项真实进程 stdio 契约检查全部通过，
记录见 `docs/VALIDATION-2.0.md`，仓库 `Skymly/PolyPage`）。

3.0 的主题是：

> **从 HTML 走向全部内容：把翻译能力扩展到 PDF、图片、视频字幕三大载体，
> 同时收口 2.0 遗留的体验欠账，把「好用」提升为「随处可用」。**

四大支柱（延续 2.0 的字母编号）：

1. **支柱 E：PDF 双语阅读器** —— 兑现 1.0 §4.10 / 2.0 §4.1 「延后至 3.0」的 PDF 翻译；
2. **支柱 F：图片 OCR 翻译** —— 兑现 1.0 §4.11 / 2.0 §4.2 的图片 OCR 翻译；
3. **支柱 G：视频字幕翻译** —— 兑现 1.0 §4.12 / 2.0 §4.3 的视频字幕翻译；
4. **支柱 H：体验收口与健壮性** —— 吸收 2.0 §3 P2 遗留项（语言自动检测、质量反馈、
   划词发音、续译）与 2.0 §13 的「分块幂等续译」2.1 备选项。

请严格遵循以下原则：

1. 2.0 功能零回退：所有六种显示模式、消息协议 v2、设置 schema v2、
   网关 JSON-RPC 协议保持向后兼容；
2. 每个里程碑产出可加载、可运行、可验证的扩展版本（延续 1.0 原则 10）；
3. 新内容形态的翻译任务**必须复用现有后台管线**（队列 / 80ms 批量合并 / 缓存 /
   failover / 错误分类），禁止为 PDF / 图片 / 字幕新建 API 通路；
4. Provider 抽象继续演进：图片翻译以**可选能力**（`translateImage`）形式加入，
   如同 2.0 的 `translateStream`；不支持该能力的 Provider 静默降级（入口置灰 + 原因提示）；
5. **用户触发优先**：图片 / 视频 / PDF 内容一律不做全自动批量处理，
   防止 API 费用失控（唯一例外：PDF 阅读器打开后的按页惰性翻译，受视口限制）；
6. 不破坏原始内容：不修改 PDF 源文件、不修改视频源与字幕文件、
   翻译面板不插入页面正文 DOM（延续 Shadow DOM 隔离纪律）；
7. 设置结构升级必须提供自动迁移（schemaVersion 2 → 3），不得破坏 2.0 用户配置；
8. 每项新功能必须补充对应层级的验证（单元测试 / 冒烟夹具），延续 1.0/2.0 验证文化；
9. 仍优先支持 Chrome 和 Edge，Manifest V3，**不引入远程代码执行机制**：
   pdf.js / WASM / 语言检测器全部本地打包，按需懒加载；
10. 敏感信息纪律不变：API Key 只存于后台 / 本地网关，内容脚本与新视图页零接触。

---

## 1. 项目名称

Web Translator Extension **3.0**

可简称为：

> Web Translator 3.0 / PolyPage 3.0

---

## 2. 与 2.0 的关系

1. 2.0 的 Provider 抽象、后台管线、存储层、渲染层、网关协议全部保留并演进，不推倒重来；
2. 1.0/2.0 明确标注「延后至 2.x/3.0」的三个非目标（PDF、图片 OCR、视频字幕）
   在 3.0 升级为正式目标（支柱 E/F/G）；
3. 2.0 §3 P2 未兑现项（划词发音、快捷键重复划词、页面语言自动检测、质量反馈入口）
   在 3.0 升级为正式功能（支柱 H）；llama.cpp 专属样例不再立项
   （现有 HttpBackend 模板即可覆盖，已在 2.0 验证记录 §7.5 说明）；
4. 2.0 §13 风险表中的「分块幂等续译（2.1 备选）」在 3.0 正式立项（支柱 H）；
5. 2.0 的划词面板（Shadow DOM 浮层组件）作为 3.0 图片翻译 / 质量反馈的 UI 基座复用；
6. 2.0 的视口惰性翻译思想（虚拟列表）复用于 PDF 按页翻译与长文档预算控制；
7. 2.0 的站点规则机制扩展 `subtitleSelectors` 字段（支柱 G），规则结构保持宽容归一化风格；
8. 2.0 的构建管线（`scripts/build.mjs` 多段构建）、冒烟框架
   （`scripts/smoke-test.mjs` + mock API + 真实网关联调）直接复用并扩展；
9. 网关（native-host）在 3.0 **默认不改动**：图片经网关的本地视觉翻译列为 P2，
   避免协议与扩展双线作战。

---

## 3. 3.0 版本目标

按优先级分为 P0（必须）、P1（应当）、P2（尽力）：

### P0

1. 设置 schema v3 与自动迁移（v2 → v3 只补默认值）；
2. **PDF 双语阅读器 MVP**：扩展内独立阅读器页（本地打包 pdf.js），
   弹窗/右键入口打开，逐页文本提取与段落聚类，按页惰性翻译，
   双语块与「译文 + 悬停原文」两种显示，文档指纹缓存，无文本层扫描页明确提示；
3. **图片翻译 MVP**：右键菜单 / 悬停按钮触发，多模态 LLM 视觉一步翻译
   （图片 + Prompt → 结构化「原文片段 + 译文」），Shadow DOM 结果面板，
   不支持视觉能力的 Provider 入口置灰；
4. **视频字幕翻译 MVP**：HTML5 `<video>` + `<track>`（WebVTT）字幕接管，
   自绘双语字幕层（原文/译文/双语三档），按 cue 缓存，开关与字号可调；
5. **页面语言自动检测**：本地零依赖检测器，`sourceLanguage=auto` 时生效，
   Popup 显示检测语言，页面主语言 = 目标语言时抑制自动翻译；
6. 全部新增功能的单元测试 + 冒烟夹具扩展。

### P1

1. PDF 阅读器增强：页内目录（outline）侧栏、双语 Markdown/HTML 导出（复用 2.0 导出基座）、
   扫描页转图片走视觉 OCR（支柱 F 联动）、可选 `webNavigation` 自动打开
   （optional_permissions，默认关闭）；
2. 图片翻译增强：本地 Tesseract.js（WASM）离线 OCR 引擎（动态分包、用时加载）、
   图上原位覆盖渲染（简单版面：半透明底 + 译文覆盖，复杂版面不承诺）、
   面板内单条重译 / 编辑回写缓存；
3. 视频字幕增强：站点规则 `subtitleSelectors`（自绘字幕 DOM 的就地监听翻译，
   覆盖 YouTube 等站点）、字幕位置 / 字号 / 背景样式设置、双语字幕上下位置互换；
4. **翻译质量反馈**：双语块 / 字幕 / PDF 块悬停「标记坏句」，
   写入独立反馈日志（含原文 / 译文 / Provider / 页面），Options 查看与 CSV/JSON 导出；
5. 划词翻译发音（`speechSynthesis`，按目标语言选声）+ 快捷键重复上一次划词（默认 Alt+Q）；
6. **续译**：后台任务表持久化（IndexedDB），SW 重启 / 崩溃后按 tab 恢复在途任务，
   以缓存幂等跳过已完成条目。

### P2

1. Chrome Web Store 上架准备：隐私政策页、权限说明、商店素材（截图 / 描述）；
2. 网关图片翻译方法（`translate.image`，本地视觉模型经 Ollama），协议向后兼容扩展；
3. 图片 OCR 附加语言训练数据按需下载（明确数据下载声明，非代码）；
4. 句子级翻译记忆（TM）探索：高频句跨页复用，与缓存的边界评估；
5. PDF 双栏 / 表格聚类质量专项优化（启发式参数按文档类型可调）。

---

## 4. 3.0 非目标

以下内容 3.0 不实现（延续 1.0/2.0 边界或明确延后）：

1. **不实现语音识别自动生成字幕（ASR）**：无字幕视频的音频转写工作量与模型体积
   超出 3.0，记为 4.0 候选（网关侧 Whisper 后端是自然路径）；
2. 不实现音频 / 播客内容翻译；
3. 不修改 PDF 源文件、不实现 PDF 编辑器（批注 / 表单填写 / 重排）；
4. 不追求图片原位渲染的像素级版面还原（字体 / 排版重建属修图范畴）；
5. 不实现账号系统、云端配置同步（延续）；
6. 不支持 Firefox / Safari（延续；MV3 差异评估列为 4.0 候选）；
7. 不实现可视化拖拽站点规则编辑器（延续）；
8. 不实现自动更新服务端、企业级审计日志（延续）；
9. 不绕过 DRM：加密 PDF 与 Widevine 保护流只处理浏览器可读的部分，
   不破解、不解密；
10. 不实现移动端适配。

---

## 5. 支柱 E：PDF 双语阅读器

### 5.1 方案选型

不接管浏览器内置 PDF 查看器（Chrome PDF Viewer 无法注入），不修改源文件。采用：

> **扩展内独立阅读器页**：`pdf-viewer.html?src=<encodedUrl>`，
> 本地打包 pdf.js 渲染，文本层提取后走后台管线翻译。

理由：MV3 无远程代码约束下 pdf.js 可完整本地打包；独立页面对 DOM 有完全控制权，
渲染 / 恢复 / 导出都简单；与 1.0「优先保证稳定性」原则一致。

### 5.2 入口

1. Popup：检测当前标签页为 PDF（URL 启发式 + `contentType` 探测）时显示
   「用 PolyPage 打开双语阅读器」；
2. 右键菜单：PDF 页面 / 指向 PDF 的链接上「用 PolyPage 打开」（`contextMenus`，
   复用 2.0 权限，不新增）；
3. P1：`webNavigation` 可选权限，用户显式开启后对配置的站点自动打开阅读器。

### 5.3 文本提取与段落聚类

1. pdf.js `getTextContent()` 逐页提取 textItem（含 transform / fontName / 行坐标）；
2. 聚类启发式：同页内按 Y 坐标分行 → 行距 / 字号 / 缩进突变换段；
   连字符断行合并；跨页段落默认不合并（P2 优化）；
3. 过滤：页眉页脚（跨页重复短行）、页码（纯数字短行）、脚注编号行，
   启发式可全局开关（`pdfViewer.skipHeadersFooters`，默认开）；
4. 无文本层（扫描页）：整页标记 `scanned`，P0 显示提示占位；
   P1 将该页渲染为图片送支柱 F 视觉管线。

### 5.4 显示与交互

1. 两种显示模式（沿用 1.0 术语）：
   - `bilingual`（默认）：原文段落 + 下方译文块，复用 2.0 双语块样式基座；
   - `translated_hover_original`：主体译文，悬停显示原文（复用 Tooltip 组件）；
2. 按页惰性翻译：页容器进入视口才提交任务（复用虚拟列表视口思想），
   单页段落任务进后台队列批量合并；
3. 预算：单文档待翻译段落超过阈值（默认 2000）时提示用户并降级为「仅当前视口 ±1 页」；
4. 恢复 / 关闭：关闭阅读器即结束，页面本身无 DOM 残留（独立页面）；
   阅读器内可随时切回「仅原文」；
5. 进度：阅读器顶栏显示 已译/总段 与失败数，失败段可重试（复用 1.0 失败重试语义）。

### 5.5 缓存与请求

1. 文档指纹：优先 PDF 文件 ID（trailer ID），回退为「响应头 etag/last-modified +
   文件大小 + 前 4KB 哈希」；
2. 缓存键 = 指纹 + 页码 + 段落序号 + 文本哈希 + 语言对 + glossaryVersion（延续 2.0 键结构）；
3. 请求全部经后台管线：批量合并 / 超时 / 重试 / failover / 错误分类不变；
4. 大文档保护：同一文档并发页 ≤ 3（防止一次性打满 Provider 限流）。

---

## 6. 支柱 F：图片 OCR 翻译

### 6.1 引擎抽象

新增 `OcrEngine` 接口（与 Provider 抽象平行但更薄）：

```ts
interface OcrEngine {
  id: 'llm-vision' | 'tesseract-wasm';
  /** 一步法：返回结构化片段 [{ text, translation }]；tesseract 仅返回 text，翻译走文本管线 */
  recognize(input: ImageInput, ctx: TranslateContext, signal: AbortSignal): Promise<OcrResult>;
}
```

1. P0 只实现 `llm-vision`：多模态 LLM 一步产出「原文片段 + 译文」JSON；
2. P1 实现 `tesseract-wasm`：本地 OCR 出文本 → 复用现有文本翻译管线（两步法，离线可用）；
3. 引擎选择在 Options「图片翻译」分区，默认 `llm-vision`。

### 6.2 llm-vision 与 Provider 集成

1. `openai-compatible` Provider 增加可选能力 `translateImage(dataUrl, ctx, signal)`
   （仿 2.0 `translateStream` 的可选能力模式）；不支持视觉的 Provider / 网关不实现该方法；
2. 请求：chat/completions，user message 含 `image_url`（base64 data URL）+
   结构化输出 Prompt（只返回 JSON 数组：`[{ "text": ..., "translation": ... }]`，
   不返回解释）；术语表 `{{glossary}}` 照常注入；
3. 能力探测：Popup / 右键菜单入口按当前 Provider 是否实现 `translateImage` 置灰 + 提示；
4. 图片预处理：最大边 4096px、体积 8MB 上限，超限先 canvas 降采样再编码（控制费用与延迟）。

### 6.3 入口与 UI

1. 右键菜单：图片上「翻译图片文字」（复用 `contextMenus`）；
2. 悬停按钮：宽或高 ≥ 200px 的图片，鼠标悬停显示小按钮（可在设置关闭；
   黑名单站点沿用 2.0 敏感站点机制）；
3. 结果面板：Shadow DOM 浮层（划词面板基座扩展），逐条「原文 + 译文」，
   单条复制 / 全部复制 / 收起；面板不插入页面正文 DOM；
4. 状态：处理中骨架、失败原因（按 ErrorKind 归因）、取消按钮（AbortController）。

### 6.4 缓存与隐私

1. 缓存键：可 fetch 的图片取内容哈希；跨域不可读的取 URL + 自然尺寸，
   键结构仍含语言对 + glossaryVersion；
2. 费用与隐私保护：**只响应用户点击**，绝不自动扫描 / 上传页面图片；
   Options 显示「图片翻译」独立开关（默认开，入口可见即手动触发）。

---

## 7. 支柱 G：视频字幕翻译

### 7.1 MVP：`<track>` 字幕接管

1. 检测：页面内 `<video>` 且存在 `textTracks`（kind=subtitles/captions）；
2. 接管：将原 track `mode` 置 `hidden`（不改视频源、不删 track），
   监听 `cuechange` / `timeupdate`，在自绘字幕层渲染当前 cue；
3. 字幕层：Shadow DOM 容器挂载于 video 父元素，绝对定位底部，
   全屏（fullscreenchange）时跟随；样式可调（字号 / 背景 / 位置，P1）；
4. 双语档位：仅原文 / 仅译文 / 双语（默认，原文上译文下；P1 可互换）；
5. 翻译时机：cue 首次激活时提交（短文本、单条，不走批量窗口以免延迟），
   结果按 cue 文本缓存——字幕重复率高，缓存命中显著；
6. 多视频页面：每个 video 独立状态；Popup 字幕开关作用于当前激活（最近交互）视频；
7. 关闭即还原：恢复原 track `mode`，移除字幕层，零残留。

### 7.2 P1：自绘字幕站点适配（subtitleSelectors）

1. 站点规则新增字段 `subtitleSelectors: string[]`：对自绘字幕 DOM 的站点
   （如 YouTube 字幕容器），内容脚本对命中节点做文本变化监听（MutationObserver，
   150ms 防抖），就地替换为「译文（悬停看原文）」或双语两行；
2. 复用 2.0 原文映射 / 恢复机制，保证还原；
3. 内置规则随版本更新（先收 1–2 个高流量站点），用户规则优先；
4. 明确已知限制：站点改版即失效，属规则驱动的天然边界。

### 7.3 边界

1. 无字幕视频不处理（ASR 为 3.0 非目标，见 §4.1）；
2. DRM 保护流：只处理浏览器已可读的 track，不破解；
3. 字幕翻译同样受敏感站点黑名单约束。

---

## 8. 支柱 H：体验收口与健壮性

### 8.1 页面语言自动检测（2.0 P2 遗留）

1. 本地零依赖检测器：Unicode script 粗分类 + 内置高频停用词表（zh/en/ja/ko/ru/es/fr/de 等
   12 语言），扫描首批段落文本投票，整体 < 5KB 代码体积；
2. 生效场景：`sourceLanguage=auto` 的 Provider 任务填充检测语言；
   Popup 状态区显示「页面语言：xx」；
3. 自动翻译守护：设置「默认自动翻译」开启时，若页面主语言 = 目标语言则跳过并提示
   （防止母语页面被无意义翻译）；
4. 检测失败 / 不确定时回退原行为（auto 直传 Provider）。

### 8.2 翻译质量反馈（2.0 P2 遗留）

1. 双语块 / PDF 译文块 / 字幕层 / 划词面板悬停显示「标记坏句」小按钮；
2. 反馈日志独立于错误日志（环形 200 条）：原文 / 译文 / Provider / 页面 URL / 时间；
3. Options「反馈日志」查看、单条删除、CSV / JSON 导出（供用户向 Provider 调 Prompt）；
4. 标记不改变渲染，仅记录；被标记条目附 `feedback` 标记参与导出。

### 8.3 划词增强（2.0 P2 遗留）

1. 发音：划词面板新增「朗读」按钮，`speechSynthesis` 按目标语言选声朗读译文
   （不可用时按钮置灰）；原文长按 Alt 点击朗读原文；
2. 快捷键重复上一次划词：默认 Alt+Q（commands 新增，可改键），
   无选区时重放上次结果面板；
3. 设置项纳入 schema v3（`selectionTranslate` 结构扩展 `speak: boolean`）。

### 8.4 续译（2.0 §13 的 2.1 备选转正）

1. 后台任务表持久化于 IndexedDB：`{ tabId, frameId, taskKey, textHash, state, ts }`；
2. SW 重启 / 崩溃恢复：激活时扫描 `state=in-flight` 且 tab 仍存活的记录，
   重建队列；已完成条目靠缓存幂等跳过；
3. 与 2.0 端口保活共存：保活是首选路径，续译是兜底路径；
4. 任务表按 tab 关闭清理（`tabs.onRemoved`），总量上限 5000 条环形淘汰。

---

## 9. 架构演进

### 9.1 模块增量（在 2.0 基础上）

| 模块 | 变化 |
|---|---|
| providers | `openai-compatible.ts` 增加可选 `translateImage`；`provider.ts` 能力声明增加 `vision` 位 |
| background | 新增 OCR 请求路由、任务表持久化（IndexedDB）、反馈日志环形区、PDF 文档级并发控制 |
| content | 新增 `media.ts`（字幕接管与字幕层）、`imageButton.ts`（图片悬停按钮）、`feedback.ts`（坏句标记）；`rules.ts` 增加 `subtitleSelectors` 应用 |
| viewer（★ 新增） | `pdf-viewer.html` + pdf.js 集成、文本聚类（`pdf/segment.ts`）、按页渲染、进度条 |
| ocr（★ 新增） | `ocr/engine.ts` 抽象 + `llm-vision.ts`（P0）+ `tesseract.ts`（P1，动态分包） |
| shared | `languageDetect.ts`（★）、`types.ts` 增加 OCR / 字幕 / 反馈类型 |
| storage | settings schema v3 + 迁移；`feedback.ts` 反馈日志存储 |
| messaging | 协议 v3：`v: 3` 标记，v1/v2 兼容 |
| options | 图片翻译 / 字幕 / PDF / 语言检测 / 反馈日志分区 |
| popup | PDF 检测入口、字幕开关、页面语言显示 |

### 9.2 消息协议 v3

1. 所有 RuntimeMessage 标记 `v: 3`（v 缺省按低版本处理，兼容 1.0/2.0 内容脚本）；
2. 新增：`ocr-request` / `ocr-result` / `ocr-cancel`、`pdf-open` / `pdf-progress`、
   `subtitle-toggle` / `subtitle-state`、`mark-feedback`、`resume-inflight`（SW 恢复内部消息）；
3. TabCommand 新增：`wt:open-pdf-viewer`、`wt:translate-image`、`wt:toggle-subtitles`、
   `wt:repeat-selection`。

### 9.3 设置 schema v3

1. `schemaVersion: 3`；延续宽容归一化风格；
2. 新增字段（全部可缺省，缺省走默认）：
   `pdfViewer: { enabled, defaultMode, skipHeadersFooters, maxConcurrentPages }`、
   `imageTranslate: { enabled, trigger: 'contextMenu'|'hoverButton'|'both', engine, maxEdgePx }`、
   `subtitles: { enabled, bilingual: 'both'|'src'|'dst', fontSizePct }`、
   `languageDetection: 'auto'|'off'`、`selectionSpeak: boolean`；
   站点规则项增加可选 `subtitleSelectors`；
3. v2 → v3 迁移：仅补默认值，不清空任何已有字段；v3 设置可被 2.0 代码安全读取
   （2.0 `normalizeSettings` 忽略未知字段——需补回归测试，延续 2.0 对 1.0 的同款保证）。

### 9.4 权限变化

| 权限 | 状态 | 用途 |
|---|---|---|
| `storage` / `nativeMessaging` / `contextMenus` | 保留 | 既有功能 + 新菜单项 |
| `<all_urls>` host | 保留 | PDF 抓取、任意 API 端点 |
| `webNavigation` | **P1 新增 optional_permissions** | PDF 自动打开（默认不授予） |

无新增必选权限——PDF 阅读器是扩展页，图片抓取与字幕接管都在既有 host 权限内。

---

## 10. 推荐目录结构（3.0 增量）

```text
PolyPage/
├── src/
│   ├── viewer/                       # ★ PDF 双语阅读器
│   │   ├── pdf-viewer.html
│   │   ├── main.ts                   #   入口、进度、模式切换
│   │   └── pdf/
│   │       ├── loader.ts             #   pdf.js 本地打包与懒加载
│   │       └── segment.ts            #   文本提取与段落聚类
│   ├── ocr/                          # ★ 图片 OCR
│   │   ├── engine.ts                 #   OcrEngine 抽象
│   │   ├── llm-vision.ts             #   多模态一步翻译（P0）
│   │   ├── resultPanel.ts            #   Shadow DOM 结果面板
│   │   └── tesseract.ts              #   本地 WASM OCR（P1，动态分包）
│   ├── content/
│   │   ├── media.ts                  # ★ 字幕接管 + 自绘字幕层
│   │   ├── imageButton.ts            # ★ 图片悬停翻译按钮
│   │   ├── feedback.ts               # ★ 坏句标记
│   │   └── ...(2.0 文件演进)
│   ├── shared/
│   │   ├── languageDetect.ts         # ★ 语言自动检测
│   │   └── ...(2.0 文件演进)
│   ├── storage/
│   │   ├── feedback.ts               # ★ 反馈日志
│   │   ├── taskTable.ts              # ★ 续译任务表（IndexedDB）
│   │   └── ...(settings/cache 演进至 schema v3)
│   └── ...(2.0 结构保持)
├── vendor/                           # ★ pdf.js 本地发行版（构建期校验哈希）
├── tests/                            # 扩充：聚类、cue 调度、vision 报文、检测器、v2→v3 迁移
└── scripts/
    └── fixtures/                     # ★ 新增：样例 PDF、mock vision 端点、video+vtt 页
```

---

## 11. 里程碑与阶段安排

延续 2.0 的里程碑编号（M1–M3 已交付），按风险从低到高排序；
每个里程碑结束时必须满足「可加载 + 冒烟全绿 + 2.0 用例零回退」。

### M4 —— 体验收口与健壮性（支柱 H）

1. 设置 schema v3 与迁移（含 v3→v2 读兼容回归测试）；
2. 语言自动检测 + 自动翻译守护；
3. 质量反馈（标记入口 + 反馈日志 + 导出）;
4. 划词发音 + Alt+Q 重复划词；
5. 续译任务表与 SW 恢复。

退出标准：v2→v3 迁移与读兼容测试通过；检测器对 12 语言样本语料判定正确率 ≥ 90%；
续译在模拟 SW 终止后恢复断言通过；2.0 全部 83 单元 + 61 冒烟保持通过。

### M5 —— PDF 双语阅读器（支柱 E）

1. pdf.js 本地打包与阅读器页骨架；
2. 文本聚类 + 页眉页脚过滤；
3. 按页惰性翻译 + 文档指纹缓存 + 并发控制；
4. bilingual / translated_hover_original 两种显示与进度条；
5. Popup / 右键入口；扫描页提示。

退出标准：fixture PDF（多页、双栏、含页眉页脚、含扫描页占位）冒烟断言通过；
聚类单元测试（行距换段、连字符合并、页码过滤）通过；
重复打开同文档二次翻译零 API 调用（缓存命中断言）。

### M6 —— 图片与视频（支柱 F + 支柱 G）

1. llm-vision 引擎 + Provider `translateImage` 能力 + 结果面板；
2. 图片右键 / 悬停入口、降采样、缓存；
3. `<track>` 字幕接管 + 自绘双语字幕层；
4. P1 项视进度纳入：Tesseract 分包、subtitleSelectors、字幕样式、PDF 扫描页联动。

退出标准：mock vision 端点（固定报文）请求构造 / 解析单元测试通过；
fixture 图片冒烟（入口出现 → 面板结果 → 复制载荷）通过；
fixture 视频（双 cue WebVTT）冒烟（接管 → 双语渲染 → 关闭还原）通过；
不支持视觉的 Provider 入口置灰断言通过。

---

## 12. 验收与验证要求

延续 1.0/2.0 的分层验证：

1. **单元测试**（vitest）新增覆盖：
   - PDF 段落聚类（行距 / 字号 / 连字符 / 页眉页脚 / 页码）；
   - 文档指纹生成与缓存键稳定性；
   - llm-vision 请求构造（image_url 载荷、结构化 Prompt）与响应解析（含畸形 JSON 归因）；
   - 图片降采样边界（超限 / 恰好 / 超限回退）；
   - cue 调度（激活 / 切换 / 缓存命中 / 还原）；
   - 语言检测器 12 语言样本判定；
   - schema v2→v3 迁移与 v3→v2 读兼容；
   - 任务表持久化与恢复幂等。
2. **冒烟测试**（无头 Edge + mock 服务）新增夹具：
   - 本地伺服的样例 PDF（文本页 + 扫描页占位）经阅读器页全流程；
   - mock vision 端点（返回固定结构化片段）+ 静态图片页；
   - video + WebVTT 双字幕夹具页（含 cue 切换时序）；
   - 续译场景：翻译中途模拟 SW 重启后恢复。
3. **手动联调清单**（记录结果入库，延续 `docs/VALIDATION-*.md` 体例）：
   - 真实 LLM 视觉 API 翻译截图 / 图表 / 多语言混排图片；
   - 真实网站 `<track>` 字幕与 1 个 subtitleSelectors 站点（YouTube）；
   - 大 PDF（≥ 50 页）按页翻译费用与时延记录；
   - 2.0 老设置文件升级 3.0 后全部功能正常。
4. **回归门槛**：任一里程碑合入前，2.0 的 83 单元测试 + 61 项冒烟断言 +
   28 项网关契约测试必须全绿（网关在 3.0 不改代码，契约测试原样执行）。

---

## 13. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| pdf.js 在 MV3 的 worker 加载 | 阅读器无法渲染 | 使用扩展源 module worker / `disableWorker` 回退；vendor 发行版构建期校验哈希 |
| pdf.js 打包体积（~1MB+） | 扩展体积膨胀 | 仅阅读器页懒加载；vite 分包；不影响内容脚本体积 |
| PDF 双栏 / 表格聚类错误 | 段落错乱 | 聚类启发式可调参 + 「按行」回退模式；P2 专项优化；文档页不承诺完美 |
| 扫描 PDF 无文本层 | 不可译 | P0 明确提示；P1 转图片走视觉管线（支柱联动） |
| 视觉 API 费用 / 图片隐私 | 用户误上传 | 仅用户点击触发；降采样上限；设置独立开关；文档显著提示 |
| 自绘字幕站点改版 | subtitleSelectors 失效 | 规则驱动 + 内置规则随版本更新；列为已知限制 |
| speechSynthesis 声源缺失 | 发音不可用 | 能力探测置灰，不报错 |
| IndexedDB 任务表膨胀 | 存储占用 | tab 关闭清理 + 5000 条环形淘汰 |
| Chrome Web Store 审查（PDF / 视觉能力） | 上架延迟 | 无新增必选权限、全部本地逻辑；P2 提前准备权限说明 |
| 3.0 范围过大 | 交付延期 | 支柱 H 先行（低风险速赢）；F/G 的 P1 项允许顺延至 3.1 |

---

## 14. 术语表（3.0 新增）

| 术语 | 定义 |
|---|---|
| 双语阅读器 | 3.0 引入的扩展内 PDF 阅读页（pdf.js 渲染 + 段落级翻译） |
| 段落聚类 | 将 PDF 文本层的 textItem 按行距/字号/缩进启发式还原为段落的过程 |
| 文档指纹 | PDF 的稳定标识（文件 ID 或 etag+大小+头部哈希），参与缓存键 |
| 视觉一步翻译 | 多模态 LLM 直接从图片产出「原文片段 + 译文」结构化结果的 OCR+翻译合并路径 |
| OcrEngine | 图片文字识别引擎抽象（llm-vision / tesseract-wasm） |
| 字幕层 | 接管 `<track>` 后自绘的 Shadow DOM 字幕渲染层 |
| subtitleSelectors | 站点规则新字段：匹配自绘字幕 DOM 的选择器列表，驱动就地监听翻译 |
| 续译 | SW 重启后依据持久化任务表恢复在途翻译任务的机制（缓存幂等） |
| 语言检测器 | 本地零依赖的页面主语言判定器（script 分类 + 停用词投票） |
| 反馈日志 | 用户标记的坏句记录（独立于错误日志），支持导出用于 Prompt 调优 |
