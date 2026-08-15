# 项目规划文档：网页翻译浏览器插件 4.0

## 0. 给 Agent 的总指令

本文档是 **4.0 版本的规划文档**，基于 `PolyPage.md`（1.0 规格）、`PolyPage-2.0.md`
（2.0 规划）与 `PolyPage-3.0.md`（3.0 规划）制定。
3.0 已交付并验证（strict TypeScript、163 单元测试、103 项无头浏览器端到端断言、
28 项 .NET 网关契约测试 + 9 项真实进程 stdio 契约检查全部通过，
记录见 `docs/VALIDATION-3.0.md`，仓库 `Skymly/PolyPage`）。

4.0 的主题是：

> **从「随处可见」走向「随处可听、随处可装」：把语音补进内容矩阵，
> 把网关升级为本地多模态枢纽，收口 3.0 遗留的离线/质量欠账，
> 并交付可加载的 Firefox MV3 MVP 与商店上架材料。**

四大支柱（延续 2.0/3.0 的字母编号）：

1. **支柱 I：语音与无字幕视频（ASR）** —— 兑现 3.0 §4.1 「延后至 4.0」的
   语音识别自动生成字幕；
2. **支柱 J：网关多模态升级** —— 兑现 3.0 §3 P2 / §2.9 「3.0 默认不改网关」
   的反转：`translate.image` + `transcribe` + 分块传输；
3. **支柱 K：离线与质量收口** —— 吸收 3.0 验证记录 §8 与 3.0 §3 P1/P2 未兑现项
   （tesseract-wasm、扫描 PDF→OCR、字幕样式、句子级 TM、OCR 语言包），
   **不再单开 3.1**；
4. **支柱 L：可分发与跨浏览器** —— 兑现 3.0 §4.6 「MV3 差异评估列为 4.0 候选」
   与 §3 P2 商店上架材料；Firefox 做到可加载 MVP。

请严格遵循以下原则：

1. 3.0 功能零回退：所有六种显示模式、消息协议 v3、设置 schema v3、
   网关 JSON-RPC 协议 v1 保持向后兼容（协议只增不改）；
2. 每个里程碑产出可加载、可运行、可验证的扩展版本（延续 1.0 原则 10）；
3. 新能力一律以 Provider **可选方法**加入（`transcribe` 仿 2.0 `translateStream` /
   3.0 `translateImage`）；不支持该能力的 Provider 入口置灰 + 原因提示，
   禁止为 ASR / 图片经网关新建绕过后台管线的 API 通路；
4. **用户触发优先**：禁止自动转写整页视频 / 整段播客；默认只转写当前播放起
   有限窗口，整段需二次确认，防止 API 费用与本地算力失控；
5. **不随插件分发模型权重**：Whisper / 视觉模型由用户自装（网关编排
   whisper.cpp / faster-whisper / Ollama 视觉模型），扩展只传音频/图片；
6. 不破坏原始内容：不修改视频源、不写入字幕文件、不修改 PDF 源文件；
   ASR 产物是内存 cue，关闭即丢弃（用户显式导出除外）；
7. 设置结构升级必须提供自动迁移（schemaVersion 3 → 4），不得破坏 3.0 用户配置；
8. 每项新功能必须补充对应层级的验证（单元测试 / 冒烟夹具），延续 1.0/2.0/3.0
   验证文化；
9. 仍以 Chrome 和 Edge 为发行主线，Manifest V3，**不引入远程代码执行机制**：
   tesseract WASM / 语言包全部本地打包或用户显式下载（数据，非代码）；
10. 敏感信息纪律不变：API Key 只存于后台 / 本地网关，内容脚本与新视图页零接触；
    **无新增必选权限**（不申请麦克风）；网关仍是可选依赖。

---

## 1. 项目名称

Web Translator Extension **4.0**

可简称为：

> Web Translator 4.0 / PolyPage 4.0

---

## 2. 与 3.0 的关系

1. 3.0 的 Provider 抽象、后台管线、存储层、渲染层、PDF 阅读器、OCR 引擎抽象、
   字幕层全部保留并演进，不推倒重来；
2. 3.0 §4.1 明确标注「不实现 ASR，记为 4.0 候选」在 4.0 升级为正式目标（支柱 I）；
   网关侧 Whisper 后端是其自然路径（支柱 J）；
3. 3.0 §2.9 / §3 P2「网关默认不改动 / `translate.image` 列为 P2」在 4.0 反转：
   网关协议 1 → 2，只增不改（支柱 J）；
4. 3.0 验证记录 §8 遗留项（tesseract-wasm 接口已留、WASM 未落地；字幕上下对调 /
   背景自定义；扫描 PDF 停在提示；P2 的商店材料 / TM / OCR 语言包 / 双栏聚类专项）
   **全部吸收进 4.0，不再单开 3.1**（支柱 K + L）；
5. 3.0 的字幕层（`media.ts` + `CueScheduler`）作为 ASR 产物的渲染基座复用：
   转写结果变成内存 cue，翻译 / 双语档位 / 关闭还原走同一路径；
6. 3.0 的 `OcrEngine` 抽象（`ocr/engine.ts`）在 4.0 兑现 `tesseract-wasm` 真实实现，
   扫描 PDF 页渲染为图片后走同一引擎，不再另开通路；
7. 3.0 的构建管线（`scripts/build.mjs` 六段构建）、冒烟框架
   （`scripts/smoke-test.mjs` + mock API + 真实网关联调）直接复用并扩展；
8. 3.0 的 `native-host` Provider **尚未实现** `translateImage`（3.0 有意不改网关）；
   4.0 补上该方法，并新增可选 `transcribe`；
9. 演进对照：

| 版本 | 主题 | 兑现的上一版欠账 |
|---|---|---|
| 1.0 | 网页翻译 MVP | — |
| 2.0 | 能用 → 好用、广用 | Native Host、站点兼容、划词、更多 Provider |
| 3.0 | HTML → 全部内容 | PDF / 图片 / 字幕 + 体验收口 |
| **4.0** | **可见 → 可听、可装** | **ASR、网关多模态、3.1 遗留、Firefox/上架** |

---

## 3. 4.0 版本目标

按优先级分为 P0（必须）、P1（应当）、P2（尽力）：

### P0

1. 设置 schema v4 与自动迁移（v3 → v4 只补默认值）；
2. **网关协议 v2**：`capabilities` 增加 `supportsVision` / `supportsAsr` /
   `maxBinaryBytes`；新增 `translate.image`、`transcribe`、`binary.chunk`；
   旧 28+9 契约测试原样全绿；网关版本号升为 `4.0.0`，`ProtocolVersion = 2`；
3. **无字幕视频 ASR MVP**：用户点击「转写并翻译」后，从当前播放位置起默认 90 秒
   窗口采集（`captureStream` + `MediaRecorder`），经 Provider `transcribe` 或
   网关 Whisper 得到文本，切成内存 cue，复用 3.0 字幕层翻译 / 渲染；
   已有 `<track>` 的视频仍走 3.0 接管，**不默认 ASR**；
4. **tesseract-wasm 真实落地**：兑现 3.0 §6.1 item 2 已留的引擎 id；
   WASM 动态分包，两步法（本地 OCR → 现有文本翻译管线）；
5. **PDF 扫描页 → 当前 `OcrEngine`**：扫描页不再停在提示；按用户确认后将该页
   渲染为图片送 llm-vision 或 tesseract（由 `imageTranslate.engine` 决定）；
6. 全部新增功能的单元测试 + 冒烟夹具扩展。

### P1

1. **Firefox MV3 可加载 MVP**：网页六模式 + 划词必须可用；Native Host / PDF /
   ASR 允许降级并在 Options 标明原因；先产出 MV3 差异表；
2. **Chrome Web Store 上架材料**：隐私政策页、权限说明、listing 草稿（截图描述 /
   商店文案）；**「已上架」不是退出条件**；
3. `<audio>` / 播客转写：复用 ASR 管线，入口为媒体元素右键 / Popup；
   整段转写二次确认；
4. 字幕样式收口：上下对调、背景色/不透明度、垂直位置（兑现 3.0 验证记录 §8.2）；
5. 句子级翻译记忆（TM）：默认关闭；精确匹配跨页复用，与缓存边界见 §7.4；
6. OCR 语言包按需下载（数据，非代码；Options 明确下载声明）；
7. 网关 `WhisperBackend`：用户自装 whisper.cpp 或 faster-whisper HTTP 服务，
   网关只做进程/HTTP 编排，不内嵌权重。

### P2

1. PDF 双栏 / 表格聚类专项优化（3.0 §3 P2 / 验证记录 §8.6，启发式参数按文档类型可调）；
2. ASR 流式 cue（边转写边出字幕，依赖后端是否支持 streaming transcription）；
3. 更多自绘字幕站点内置规则（在 YouTube 之外再收 1–2 个高流量站点）；
4. Firefox 网关真联调（Mozilla NativeMessagingHosts 注册表 + `allowed_extensions`）；
5. 图片原位覆盖简单版（3.0 §3 P1 未兑现：半透明底 + 译文覆盖，复杂版面不承诺）。

---

## 4. 4.0 非目标

以下内容 4.0 不实现（经确认延续 1.0 起的边界）：

1. 不实现账号系统、云端配置同步、多用户配额；
2. 不实现可视化拖拽站点规则编辑器（规则仍为结构化表单 + JSON）；
3. 不实现自动更新服务端（扩展与网关均走手动 / 商店更新）；
4. 不实现企业级审计日志与集中管控；
5. 不实现移动端适配；
6. 不实现 Safari（打包模型不同，单独立项）；Firefox AMO 上架本身不做
   （4.0 只交付可加载 MVP + 差异表，不上架）；
7. 不实现 PDF 编辑器（批注 / 表单填写 / 重排 / 写回源文件）；
8. 不追求图片原位渲染的像素级版面还原（字体 / 排版重建属修图范畴）；
9. 不绕过 DRM：加密 PDF 与 Widevine 保护流只处理浏览器可读的部分，
   不破解、不解密；无字幕且无法 `captureStream` 的受保护媒体明确提示后跳过；
10. 不申请麦克风权限、不实现系统级会议录音 / 输入框翻译 / 实时口译耳机模式；
11. 不随插件分发 Whisper / tesseract 训练数据之外的模型权重
    （tesseract 默认 eng+chi_sim 可随 WASM 分包；其余语言包用户显式下载）。

---

## 5. 支柱 I：语音与无字幕视频（ASR）

### 5.1 方案选型

不在扩展里跑 Whisper（模型体积与 WASM SIMD 兼容性超出 MV3 内容脚本预算）。采用：

> **采集在页面，转写在 Provider / 网关，渲染复用 3.0 字幕层。**

理由：与 2.0 `translateStream`、3.0 `translateImage` 同一「可选能力」模式；
采集用 `HTMLMediaElement.captureStream()` + `MediaRecorder`，**不使用**
`chrome.offscreen`（Chrome 专有，否则 Firefox MVP 做不成）；不申请 `audioCapture`
/ 麦克风权限——只捕获标签页内已有媒体元素的输出。

### 5.2 入口与触发

1. Popup：当前页存在无 `<track>`（或 track 为空）的 `<video>` / `<audio>` 时
   显示「转写并翻译」；已有可用 track 时显示 3.0 字幕开关，**不并列 ASR 为默认**；
2. 右键菜单：媒体元素上「转写并翻译」（复用 `contextMenus`，不新增权限）；
3. 默认窗口：从**当前播放位置**起 `asr.maxSeconds`（默认 90）秒；
   整段 / 超过阈值必须二次确认（对话框写明预估时长与「将上传音频到当前 Provider
   或本地网关」）；
4. 进行中可取消（AbortController）；取消后移除未完成的内存 cue，已写入字幕层的
   片段保留到用户关闭字幕；
5. 敏感站点黑名单沿用 2.0 机制，命中则入口隐藏。

### 5.3 采集

1. `video.captureStream()` / `audio.captureStream()` 取音轨；失败（DRM、跨源、
   浏览器不支持）→ 入口置灰 + `ErrorKind=config` 原因；
2. `MediaRecorder` 优先 `audio/webm;codecs=opus`，回退 `audio/webm` /
   `audio/mp4`；采样目标：单声道、≤ 16 kHz 等价（能降采样则降，不能则原样上传）；
3. 分块落内存 `Blob`，单次任务上限 `asr.maxUploadMb`（默认 20）；超限截断并提示；
4. 采集期间暂停/seek：以「开始转写时的 currentTime + maxSeconds」为硬窗口，
   不跟随用户后续 seek（避免不可复现）；
5. 不写磁盘；SW 重启后未完成的 ASR 任务丢弃（不像 3.0 续译那样恢复——音频 blob
   无法廉价持久化）。已完成 cue 的**译文**仍走普通翻译缓存。

### 5.4 转写与切 cue

1. Provider 可选能力：

```ts
transcribe?(
  input: { mime: string; bytes: Uint8Array },
  ctx: TranslateContext & { languageHint?: string },
  signal: AbortSignal,
): Promise<{ text: string; segments?: AsrSegment[] }>;
```

2. `openai-compatible`：`POST {baseUrl}/v1/audio/transcriptions`
   （multipart `file` + `model`，`response_format=verbose_json` 优先以保留时间戳；
   不支持 verbose 时回退纯文本再按句号/时长均分）；
3. `native-host`：走网关 `transcribe`（见 §6.3）；网关 `supportsAsr=false` 时
   该方法不注册，入口置灰；
4. 其他 Provider（DeepL / Azure / Google / custom-http）默认不实现；
5. 切 cue 规则：优先用后端 `segments[]`（`start`/`end`/`text`）；否则按句末标点
   切分，每段赋予均匀时间戳（窗口起点 + 比例）；空段丢弃；单 cue 超过 80 字再切；
6. 内存 cue 注入 `CueScheduler`（3.0 已有），其后翻译 / 双语档位 / 缓存 /
   关闭还原与 `<track>` 路径完全相同；
7. 转写语言 hint：`sourceLanguage=auto` 时用 3.0 页面语言检测器结果；
   用户指定源语言则原样传递。

### 5.5 边界

1. 有可用 `<track>` 的视频：3.0 接管优先，ASR 入口折叠到「高级」且默认不启用；
2. DRM / 无法 captureStream：明确提示，不重试、不申请额外权限；
3. 不把 ASR 文本写回页面 DOM / 不生成可下载字幕文件（P2 以前）；
   4.0 不提供 SRT/VTT 导出（避免范围膨胀；需要时记 4.1）；
4. 同一页面多媒体：每个元素独立任务；Popup 作用于最近交互的媒体。

---

## 6. 支柱 J：网关多模态升级

### 6.1 总体原则

3.0 网关零改动在此反转，但纪律不变：

1. **协议只增不改**：未识别的方法仍返回 JSON-RPC `-32601`；旧扩展连新网关、
   新扩展连旧网关（`protocol < 2`）都能翻译文本；
2. 网关仍是**可选依赖**：未安装时扩展 = 3.0 功能集 + 云端 `transcribe`
   （若当前 Provider 实现了该方法）；
3. 凭据仍只存在网关本机；图片 / 音频字节经 Native Messaging 到达网关后
   只转发到用户配置的后端，浏览器侧不落盘；
4. Native Messaging **单帧 1MB** 限制必须用分块协议突破（图片 data URL 与
   90 秒 opus 都可能超限）——这是 2.0 §13 已记录风险的正式解法。

### 6.2 协议 v2 方法

在 2.0 §5.2 七个方法之上新增：

| 方法 | 说明 |
|---|---|
| `binary.chunk` | 分块上传：`{ transferId, index, total, mime, sha256?, data }`（`data` 为标准 Base64）；`index` 从 0 计；最后一块 `index === total - 1` 时网关拼装并校验可选 sha256；单块 payload 建议 ≤ 768 KiB，为 JSON 开销留余量 |
| `translate.image` | `{ transferId 或 dataUrl, source, target, backend? }` → `{ segments: [{ text, translation }], backend }`；优先 `transferId`（分块完成后）；小图仍允许内联 `dataUrl`（必须小于网关 `maxBinaryBytes` 且整帧 < 1MB） |
| `transcribe` | `{ transferId, source?, languageHint?, backend? }` → `{ text, segments?: [{ start, end, text }], backend }`；**不接受**内联整段音频（一律分块） |

`capabilities` 响应在 v1 字段上**追加**（缺省视为 false / 沿用旧上限）：

```ts
interface GatewayCapabilitiesV2 extends GatewayCapabilities {
  protocol: 2;
  supportsVision?: boolean;
  supportsAsr?: boolean;
  maxBinaryBytes?: number; // 拼装后上限，默认 32 * 1024 * 1024
}
```

`ping` 继续返回 `{ protocol, name, version }`；`version` 升为 `"4.0.0"`。
错误码沿用 2.0 映射；分块校验失败 / 超上限归 `-32007` config。

### 6.3 后端演进

1. `IGatewayBackend` **追加可选能力**（C# 默认接口方法或独立接口，避免打破
   现有 `OllamaBackend` / `HttpBackend` 实现）：

```csharp
Task<ImageTranslateResult>? TranslateImageAsync(byte[] image, string mime, TranslateContext ctx, CancellationToken ct);
Task<TranscriptResult>? TranscribeAsync(byte[] audio, string mime, TranslateContext ctx, CancellationToken ct);
```

   返回 `null` 表示该后端不支持；`capabilities.supportsVision / supportsAsr`
   由「至少一个后端非 null」聚合。

2. `OllamaBackend`：若配置模型声明视觉（Options / `gateway.json` 的
   `supportsVision` 标志，默认 false），则 `TranslateImageAsync` 走
   `/v1/chat/completions` 的 `image_url`（与扩展 `llm-vision` 同构 Prompt）；
3. **新增 `WhisperBackend`**（P1）：`kind=whisper`；配置
   `{ url, model?, apiKey?, command? }`——
   - HTTP 模式：OpenAI-compatible `/v1/audio/transcriptions`（faster-whisper
     的 openai-whisper-api 兼容层、或用户自建端点）；
   - 本地命令模式（可选）：`command` 模板调用用户安装的 `whisper.cpp` CLI，
     stdin/临时文件由网关管理，stdout 解析为 segments；**4.0 不随网关拷贝二进制**；
4. `HttpBackend` 可经模板转发图片/音频（P2，不作为退出条件）；
5. 扩展侧 `NativeHostProvider` 实现 `translateImage` 与 `transcribe`：
   先 `binary.chunk` 再调对应方法；旧网关 `protocol < 2` 时不注册这两方法。

### 6.4 安装器

1. Chrome / Edge 注册表项保持不变；
2. P1：追加 Firefox 的 HKCU
   `Software\Mozilla\NativeMessagingHosts\<hostName>`；
3. Firefox host manifest 使用 `allowed_extensions: ["<gecko.id>"]`，
   **不是** Chrome 的 `allowed_origins`；安装器按浏览器写两份 manifest
   （或一份同时含两个字段，Firefox 忽略未知字段——以实现时实测为准，
   差异写入 `docs/FIREFOX-MV3.md`）；
4. `--allow` 继续追加 Chrome origin；新增 `--allow-id <gecko.id>` 追加
   Firefox 扩展 ID；
5. Linux / macOS 安装路径仍不做（延续 2.0 已知限制）。

---

## 7. 支柱 K：离线与质量收口

吸收 3.0 验证记录 §8，不再单开 3.1。

### 7.1 tesseract-wasm 真实落地

1. 兑现 `src/ocr/tesseract.ts` 已注册的 `id = 'tesseract-wasm'`；
   当前实现抛 `config` 错误的占位必须替换为真实识别；
2. WASM / 核心脚本以 **动态 import 分包**加载，不进 content.js；
   vendor 哈希钉住（沿用 pdf.js 的 `scripts/vendor-hashes.json` 机制）；
3. 两步法：`recognize()` 只填 `text`（可多片段），翻译走现有
   `translateTexts` 管线（3.0 §6.1 item 2）；
4. 默认语言包：`eng` + `chi_sim`（随分包，需在隐私政策中声明「本地 OCR 数据」）；
5. 识别失败归因 `invalid_response` 或 `config`（WASM 加载失败），不得误报 network；
6. Options「图片翻译」引擎切换：`tesseract-wasm` 不要求 Provider 具备
   `translateImage`；无翻译 Provider 时只出原文（面板标明「仅识别」）。

### 7.2 PDF 扫描页 → OcrEngine

1. 3.0 P0 对无文本层页标记 `scanned` 并提示；4.0 在提示旁提供
   「识别本页」按钮（用户触发，禁止打开文档时自动全页 OCR）；
2. 将该页 pdf.js viewport 渲染为 PNG（最大边走 `imageTranslate.maxEdgePx`），
   送当前 `OcrEngine`；
3. 结果按片段插入该页译文流，缓存键 = 文档指纹 + 页码 + 图像哈希 + 引擎 id +
   语言对 + glossaryVersion；
4. 预算：单文档扫描页 OCR 默认最多 20 页，超出需确认；
5. 与支柱 F 的费用/隐私纪律相同：只响应用户点击。

### 7.3 字幕样式（3.0 验证记录 §8.2）

在现有 `subtitles.fontSizePct` + 三档双语之上补：

| 字段 | 默认 | 说明 |
|---|---|---|
| `swapSrcDst` | `false` | true 时译文在上、原文在下 |
| `background` | `rgba(0,0,0,.62)` | 字幕条背景（Options 给几档预设 + 自定义色） |
| `position` | `'bottom'` | `'bottom'` 或 `'top'`；垂直偏移百分比可后续再加，4.0 只做两档 |

关闭字幕后样式不残留（3.0 零残留纪律）。

### 7.4 句子级翻译记忆（TM，P1）

1. 与翻译缓存的边界：
   - **缓存**：精确键（文本哈希 + 语言对 + glossaryVersion [+ 引擎]），
     页内/跨页都已存在，3.0 已用；
   - **TM**：跨页的**整句精确匹配**复用（归一化：折叠空白、去首尾标点差异可选），
     命中则跳过 Provider；默认 **关闭**；
2. 存储：独立 IndexedDB 表，环形上限 5000 条；不含 URL（减少隐私面）；
   条目 `{ hash, source, target, langPair, hits, ts }`；
3. 写入：用户未关 TM 时，成功翻译且源句长度 8–240 字的句子入表；
4. Options 可清空；导出不包含 TM（避免无意扩散）；
5. 不与术语表合并（术语表走 Prompt，TM 走查表）。

### 7.5 OCR 语言包按需下载（P1）

1. tesseract 附加 `.traineddata` 视为**数据文件**，用户在 Options 勾选后下载到
   扩展可写存储（`chrome.storage.local` 不适合大文件 → 用 IndexedDB blob
   或网关目录 `%LocalAppData%\PolyPage\tessdata\`）；
2. 下载源写死为项目文档列出的官方 / 镜像 URL，构建期不打包除默认外的语言包；
3. UI 显著提示「将下载第三方 OCR 数据，体积约 x MB」；失败可重试；
4. 不实现自动更新语言包。

---

## 8. 支柱 L：可分发与跨浏览器

### 8.1 Chrome Web Store 材料（P1）

产出（仓库内，供人工提交，**提交动作本身不是 Agent 退出条件**）：

1. `docs/store/PRIVACY.md`：收集什么（设置、翻译缓存、反馈日志、可选 ASR 音频
   仅发往用户配置的端点）、不收集什么（无账号、无云同步、无分析 SDK）；
2. `docs/store/PERMISSIONS.md`：逐项说明 `storage` / `nativeMessaging` /
   `contextMenus` / `<all_urls>` / 可选 `webNavigation`；明确 **无麦克风、
   无 history、无 cookies**；
3. `docs/store/LISTING.md`：商店标题、短描述、详述草稿、截图说明（网页六模式、
   PDF、图片、字幕、划词）；
4. 不把「审核通过 / 已上架」写入里程碑退出标准（审查周期不可控）。

### 8.2 Firefox MV3 MVP（P1）

目标：**在 Firefox 最新 ESR 或当前稳定版以临时附加组件加载后，网页翻译主路径可用。**

必须可用：

1. 六种显示模式 + 恢复原文；
2. 划词翻译（含 Alt+Q 若 commands 在 Firefox 可用，否则 Options 标明降级）；
3. 设置页读写、schema v4 迁移。

允许降级（Options「浏览器兼容」区列出原因，不得抛未捕获异常）：

| 能力 | 降级策略 |
|---|---|
| Native Host | 未注册 Mozilla 键时视为未安装，走 failover；P2 再做真联调 |
| PDF 阅读器 | pdf.js worker / `chrome.runtime.getURL` 差异时阅读器入口隐藏 |
| ASR | 无 `captureStream` / `MediaRecorder` mime 时入口置灰 |
| `webNavigation` 自动打开 PDF | 权限模型不同则保持可选且默认关 |
| `chrome.offscreen` | **4.0 不使用该 API**，从根上避免 |

工程约束：

1. 新增 `docs/FIREFOX-MV3.md`：API 差异表（background、action vs browserAction
   残留、`browser` vs `chrome` 命名空间、native messaging manifest 字段、
   content script `all_frames`、commands 快捷键）；
2. 构建产出 `dist/` 继续服务 Chrome/Edge；另产 `dist-firefox/`
   （或同一 dist + `manifest.firefox.json` 合并），含
   `browser_specific_settings.gecko.id`（固定 ID，供 Native Messaging）；
3. 代码优先 `chrome.*`（Firefox 已别名）；禁止引入 Chrome-only API
   （offscreen、sidePanel、identity 等）；新增 API 必须能特性检测；
4. 冒烟：无头 Firefox 若 CI 环境不稳定，允许「可加载 + 关键单元」为退出，
   完整冒烟以 Chrome/Edge 为准，Firefox 走手动清单（记录入 VALIDATION-4.0）。

### 8.3 明确不做

Safari、iOS/Android、AMO 上架、Firefox Android。

---

## 9. 架构演进

### 9.1 模块增量（在 3.0 基础上）

| 模块 | 变化 |
|---|---|
| providers | `provider.ts` 增加可选 `transcribe`；`openai-compatible.ts` 实现 multipart 转写；`native-host.ts` 实现 `translateImage` + `transcribe` + `binary.chunk` 客户端 |
| background | ASR 任务路由（不入 3.0 续译表）、分块上传队列、TM 查表/写入（P1） |
| content | `media.ts` 增加无 track 时的 ASR 入口与内存 cue 注入；字幕样式字段应用 |
| viewer | 扫描页「识别本页」→ 复用 `OcrEngine`；不新建 OCR 通路 |
| ocr | `tesseract.ts` 真实 WASM 实现；语言包加载器（P1） |
| native-host | 协议 v2 分发；`binary.chunk` 拼装；`WhisperBackend`（P1）；安装器写 Mozilla 键 |
| shared | `types.ts` schema v4；`nativeRpc.ts` capabilities v2 |
| storage | settings schema v4 + 迁移；`tm.ts`（P1） |
| messaging | 协议 v4：`v: 4` 标记，v1/v2/v3 兼容 |
| options | ASR / TM / OCR 语言包 / 字幕样式 / 浏览器兼容 / 网关视觉与 ASR 状态 |
| popup | 无字幕媒体的转写入口、ASR 进度 |
| docs | `FIREFOX-MV3.md`、`store/*`、`VALIDATION-4.0.md`（交付时） |

### 9.2 消息协议 v4

1. 所有 RuntimeMessage 标记 `v: 4`（v 缺省按低版本处理，兼容 3.0 内容脚本）；
2. 新增：`asr-start` / `asr-progress` / `asr-result` / `asr-cancel`、
   `ocr-page`（PDF 扫描页，可复用既有 `ocr-request` 若载荷已够则不新增）、
   `tm-hit`（调试/状态，可仅内部使用）；
3. TabCommand 新增：`wt:transcribe-media`、`wt:ocr-scanned-page`。

### 9.3 设置 schema v4

1. `schemaVersion: 4`；延续宽容归一化风格；
2. 新增 / 扩展字段（全部可缺省，缺省走默认）：

```ts
asr: {
  enabled: boolean;          // 默认 true（入口可见，仍需用户点击）
  maxSeconds: number;        // 默认 90，钳制 10–600
  maxUploadMb: number;       // 默认 20
  confirmFull: boolean;      // 默认 true：超窗口必须确认
};
subtitles: {
  // 3.0 字段保留
  swapSrcDst: boolean;
  background: string;
  position: 'bottom' | 'top';
};
translationMemory: {
  enabled: boolean;          // 默认 false
  maxEntries: number;        // 默认 5000
};
pdfViewer: {
  // 3.0 字段保留
  scannedPageOcr: boolean;   // 默认 true：扫描页显示「识别本页」
};
imageTranslate: {
  // 3.0 字段保留
  tessLangs: string[];       // 默认 ['eng','chi_sim']
};
```

3. v3 → v4 迁移：仅补默认值，不清空任何已有字段；v4 设置可被 3.0 代码安全读取
   （3.0 `normalizeSettings` 忽略未知字段——需补回归测试，延续 3.0 对 2.0 的同款保证）；
4. 网关 `gateway.json` 追加可选 `whisper: []` 与 ollama 项的 `supportsVision`；
   缺省不破坏 2.0/3.0 配置文件。

### 9.4 权限变化

| 权限 | 状态 | 用途 |
|---|---|---|
| `storage` / `nativeMessaging` / `contextMenus` | 保留 | 既有 + ASR 菜单项 |
| `<all_urls>` host | 保留 | 媒体采集同源、任意 API 端点 |
| `webNavigation` | 保留 optional | PDF 自动打开 |
| 麦克风 / `tabCapture` / `offscreen` | **不申请** | ASR 只用元素 `captureStream` |

无新增必选权限。Firefox 包增加 `browser_specific_settings`，不增加权限面。

---

## 10. 推荐目录结构（4.0 增量）

```text
PolyPage/
├── src/
│   ├── asr/                          # ★ 转写客户端（切 cue、采集不放这里）
│   │   ├── engine.ts                 #   transcribe 能力探测与结果规范化
│   │   └── segment.ts                #   无时间戳时的切句
│   ├── content/
│   │   ├── media.ts                  #   演进：ASR 入口 + 内存 cue + 样式字段
│   │   └── ...(3.0 文件演进)
│   ├── ocr/
│   │   └── tesseract.ts              #   占位 → 真实 WASM
│   ├── providers/
│   │   ├── openai-compatible.ts      #   + transcribe
│   │   ├── native-host.ts            #   + translateImage / transcribe / chunk
│   │   └── provider.ts               #   + transcribe?
│   ├── storage/
│   │   ├── tm.ts                     # ★ P1 句子级 TM
│   │   └── settings.ts               #   schema v4
│   ├── viewer/pdf/
│   │   └── scannedOcr.ts             # ★ 扫描页渲染 → OcrEngine
│   └── ...(3.0 结构保持)
├── native-host/
│   ├── PolyPage.Gateway/             #   ProtocolVersion=2, Version=4.0.0
│   ├── PolyPage.Gateway.Backends/
│   │   └── WhisperBackend.cs         # ★ P1
│   └── PolyPage.Gateway.Tests/       #   分块 / image / transcribe 契约
├── docs/
│   ├── FIREFOX-MV3.md                # ★
│   ├── store/                        # ★ PRIVACY / PERMISSIONS / LISTING
│   └── VALIDATION-4.0.md             #   交付时填写
├── tests/                            # 扩充：分块、ASR 切段、tesseract 桩、
│                                     # v3→v4 迁移、扫描页 OCR 键、TM
└── scripts/
    ├── fixtures/                     # ★ 无字幕 video、webm 音频短样、扫描 PDF
    └── manifest-firefox.mjs          # ★ 合并 gecko.id 产出 dist-firefox
```

---

## 11. 里程碑与阶段安排

延续 3.0 的里程碑编号（M1–M6 已交付），按风险从低到高排序；
每个里程碑结束时必须满足「可加载 + 冒烟全绿 + 3.0 用例零回退」。

### M7 —— 离线与质量收口（支柱 K + schema）

1. 设置 schema v4 与迁移（含 v4→v3 读兼容回归测试）；
2. tesseract-wasm 真实识别 + 动态分包 + vendor 哈希；
3. PDF 扫描页「识别本页」走当前 OcrEngine；
4. 字幕 `swapSrcDst` / `background` / `position`。

退出标准：v3→v4 迁移与读兼容测试通过；tesseract 对 fixture 图片产出非空
`text` 且随后译文走文本管线（mock Provider）断言通过；扫描 PDF 夹具页
点击识别后出现译文块（或仅识别文本）；3.0 的 **163 单元 + 103 冒烟**零回退；
网关 28+9 **原样**全绿（本里程碑允许尚未改网关）。

### M8 —— 网关多模态 + ASR（支柱 J + 支柱 I）

1. 协议 v2：`binary.chunk` / `translate.image` / `transcribe` /
   capabilities 新字段；旧方法行为不变；
2. `NativeHostProvider.translateImage` + `transcribe`；
3. `openai-compatible.transcribe`（云端 multipart）；
4. 无字幕视频采集 → 转写 → 内存 cue → 3.0 字幕层；
5. P1 项视进度纳入：`WhisperBackend`、`<audio>` 播客入口。

退出标准：旧 28+9 网关契约全绿 + 新分块/image/transcribe 用例；
fixture 无字幕 video（短 webm）冒烟：点击转写 → mock transcribe 端点恰好一次
→ 双语字幕层出现 → 关闭零残留；有 `<track>` 的夹具**不**自动走 ASR；
`protocol=1` 旧网关连接时 ASR/网关视觉入口置灰不抛错；
超 1MB 的假音频经分块后网关拼装 sha256 一致。

### M9 —— 可分发（支柱 L + 余项）

1. `docs/FIREFOX-MV3.md` 差异表 + `dist-firefox/` 可在 Firefox 临时加载；
2. 网页六模式 + 划词在 Firefox 手动清单通过（记录 VALIDATION-4.0）；
3. 安装器 Mozilla 注册表键（即使 P2 才真联调，键与 manifest 字段先写上）；
4. `docs/store/*` 三份材料；
5. TM / 播客 / OCR 语言包 / WhisperBackend 若 M8 未完成本里程碑收口；
   **允许顺延 4.1** 的仅限：TM、OCR 附加语言包、ASR 流式 cue、Firefox 网关真联调、
   图片原位覆盖、双栏聚类专项。

退出标准：Firefox 临时加载不报 manifest 错误；Chrome/Edge 回归门槛全绿；
商店三份文档存在且权限表与 `public/manifest.json` 一致；
顺延项在 VALIDATION-4.0 §遗留 列出，不得 silently drop。

---

## 12. 验收与验证要求

延续 1.0/2.0/3.0 的分层验证：

1. **单元测试**（vitest）新增覆盖：
   - schema v3→v4 迁移与 v4→v3 读兼容；
   - ASR 切段（有 segments / 纯文本均分 / 超 80 字再切 / 空段丢弃）；
   - `binary.chunk` 客户端切分与 sha256；
   - tesseract 引擎在 WASM 桩上的两步法（text 有、translation 经 translateTexts）；
   - 扫描页缓存键（指纹+页+图像哈希+引擎）；
   - TM 归一化命中 / 未命中 / 环形淘汰（若 P1 落地）；
   - 字幕样式字段应用到 DOM（swap / position 类名或行序）。
2. **冒烟测试**（无头 Edge + mock 服务）新增夹具：
   - 无字幕短 video + mock `/v1/audio/transcriptions`（verbose_json 固定报文）；
   - 有 track 的 3.0 视频夹具回归：ASR 不自动启动；
   - 扫描 PDF 页「识别本页」+ mock vision 或 tesseract 桩；
   - 网关：超 1MB 分块往返 + `translate.image` 小图内联 + 旧 `translate` 回归。
3. **手动联调清单**（记录入 `docs/VALIDATION-4.0.md`）：
   - 真实 OpenAI-compatible 转写端点（或本地 faster-whisper）转写一段无字幕视频；
   - 真实 Ollama 视觉模型经网关 `translate.image`（若本机有视觉模型）；
   - Firefox 临时加载：翻译 Wikipedia 类页面六模式 + 划词；
   - 3.0 老设置文件升级 4.0 后全部功能正常。
4. **回归门槛**：任一里程碑合入前，3.0 的 163 单元 + 103 冒烟 + 28 项网关
   xunit + 9 项真实进程 stdio 必须全绿（M8 起网关测试集只增不减）。

---

## 13. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| Native Messaging 1MB | 图片/音频 RPC 失败 | 强制 `binary.chunk`；音频不走内联；单块 ≤ 768 KiB |
| `captureStream` + DRM | 无字幕受保护视频不可转写 | 特性检测置灰；文档写明已知限制；不申请 tabCapture |
| MediaRecorder mime 分裂 | Firefox/Edge 编码不同 | 能力探测 + 多 mime 回退；夹具用短 webm |
| Whisper 体积/性能 | 用户机器卡死 | 权重不进扩展；默认 90s 窗口；整段二次确认；网关超时可配 |
| tesseract WASM 体积 | 扩展膨胀 | 动态分包；默认仅 eng+chi_sim；附加包按需下载 |
| 扫描 PDF OCR 费用 | 视觉 API 打满 | 仅用户点「识别本页」；单文档 20 页预算；可改 tesseract |
| TM 误命中 | 错误译文跨页传播 | 默认关闭；仅精确匹配；Options 一键清空 |
| Firefox MV3 差异 | MVP 范围蔓延 | 主路径白名单；Host/PDF/ASR 允许降级；完整冒烟仍以 Chromium 为准 |
| CWS 审查周期 | 「上架」不可交付 | 材料进仓库即可；已上架不作退出条件 |
| 4.0 范围过大 | 交付延期 | M7 低风险先行；TM / 语言包 / 流式 ASR / Firefox 真网关允许 4.1 |
| 旧网关 protocol=1 | 新扩展崩溃 | 能力探测；不注册可选方法；failover 回云端 |

---

## 14. 术语表（4.0 新增）

| 术语 | 定义 |
|---|---|
| ASR | 自动语音识别：把媒体音轨转成带可选时间戳的文本，再走翻译管线 |
| 内存 cue | ASR 产物在页面内存中的字幕条目，注入 3.0 `CueScheduler`，关闭即丢弃 |
| 转写窗口 | 从当前播放位置起、默认 90 秒的采集上限；整段需二次确认 |
| `transcribe` | Provider 可选能力：音频字节 → 文本 / segments |
| 协议 v2 | 网关 JSON-RPC 的向后兼容增量（`binary.chunk` / `translate.image` / `transcribe`） |
| `binary.chunk` | 突破 Native Messaging 1MB 的分块上传方法 |
| WhisperBackend | 网关侧 ASR 后端，编排用户自装的 whisper.cpp 或 faster-whisper HTTP |
| 扫描页 OCR | 将 PDF 无文本层页渲染为图，送当前 `OcrEngine` |
| TM | 句子级翻译记忆：跨页精确匹配复用，默认关闭，与哈希缓存分表 |
| dist-firefox | 带 `gecko.id` 的 Firefox MV3 加载包，4.0 只要求可临时加载 |
| 商店材料 | 隐私政策 / 权限说明 / listing 草稿，供人工提交 CWS，不以上架为完成 |
