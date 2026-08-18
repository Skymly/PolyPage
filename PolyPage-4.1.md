# 项目规划文档：网页翻译浏览器插件 4.1

## 0. 给 Agent 的总指令

本文档是 **4.1 版本的规划文档**，基于 `PolyPage.md`（1.0）、`PolyPage-2.0.md`、
`PolyPage-3.0.md` 与 `PolyPage-4.0.md` 制定。
4.0 已交付并收口（schema v4、网关协议 v2、ASR MVP、tesseract-wasm、扫描页 OCR、
Firefox 可加载 MVP、商店材料；2026-08-18 本机 Ollama 文本联调与 Firefox 临时加载
已记入 `docs/VALIDATION-4.0.md`）。仓库当前主线为 `main` @ 4.0.0。

4.1 的主题是：

> **把 4.0 写下但未兑现的欠账做完：让重复句子少花钱，让离线 OCR 能加语言，
> 让 Firefox 也能连上本机网关。版面与流式属于加分，不另开大功能。**

三大 P0 支柱（延续字母编号）：

1. **支柱 M：句子级翻译记忆（TM）** —— 兑现 4.0 §7.4 与 VALIDATION-4.0 §8.1；
2. **支柱 N：OCR 附加语言包** —— 兑现 4.0 §7.5 与 VALIDATION-4.0 §8.2；
3. **支柱 O：Firefox 网关真联调** —— 兑现 4.0 §8.2 P2 / VALIDATION-4.0 §8.4。

VALIDATION-4.0 §8 其余三项不得 silently drop：ASR 流式 cue、图片原位覆盖为 P1；
PDF 双栏 / 表格聚类专项为 P2。

请严格遵循以下原则：

1. **4.0 功能零回退**：六种网页显示模式、导航菜单 `原文[译文]` 后缀、PDF / OCR /
   字幕 / ASR MVP、消息协议 v4、设置 schema v4 可读、网关协议 v2 只增不改；
2. 每个里程碑产出可加载、可运行、可验证的扩展（延续 1.0 原则 10）；
3. TM / 语言包 / 覆盖一律走现有后台管线，禁止为省事另开旁路 API；
4. TM **默认关闭**；语言包必须用户显式勾选并看到体积声明后再下载；
5. 不随插件分发新的模型权重或默认语言包以外的 `.traineddata`；
6. 不破坏原始内容：不改 PDF / 视频源；原位覆盖是叠层，不是写回图片文件；
7. 设置升级必须自动迁移（schemaVersion 4 → 5），不得破坏 4.0 用户配置；
   v5 必须仍能被 4.0 归一化安全读取（忽略未知字段）；
8. 每项新功能补对应层级验证（单元 / 冒烟 / Firefox 手动清单）；
9. 仍以 Chrome / Edge 为发行主线，Manifest V3；**无新增必选权限**，不申请麦克风；
10. 敏感信息纪律不变：API Key 只在后台 / 本机网关；TM 不含 URL；语言包是数据不是代码。

---

## 1. 项目名称

Web Translator Extension **4.1**

可简称为：

> Web Translator 4.1 / PolyPage 4.1

版本号：`package.json` / `manifest.json` / 网关 `Version` 升为 **4.1.0**。
网关 `ProtocolVersion` **保持 2**。

---

## 2. 与 4.0 的关系

1. 4.0 的 Provider 可选能力（`translateStream` / `translateImage` / `transcribe`）、
   后台队列、PDF 阅读器、字幕层、ASR 采集窗口全部保留，不推倒重来；
2. 4.0 §7.4 TM 已留 schema 字段与默认关闭，**无 `storage/tm.ts`、无查表/写入、
   无 Options 清空** —— 4.1 P0 兑现；
3. 4.0 §7.5 语言包只打包 `eng` + `chi_sim`，无下载器 —— 4.1 P0 兑现；
4. 4.0 安装器已写 Mozilla 键与 `allowed_extensions`，未做 Firefox 进程内
   Native Messaging 往返 —— 4.1 P0 兑现；
5. 4.0 验证记录 §8.3 / §8.5 / §8.6（流式 cue、原位覆盖、双栏专项）升为 4.1
   P1 / P2，不再单开 4.2 才能开工；
6. 4.0 已完成且 4.1 **不要重做**的：tesseract-wasm 本体、扫描页「识别本页」、
   WhisperBackend 代码、`<audio>` 入口、商店三份材料、Firefox 可加载 MVP；
7. 4.0 手动清单里「真实视觉 / 真实 Whisper」仍受本机模型限制，**不是 4.1 P0
   退出条件**；
8. 演进对照：

| 版本 | 主题 | 兑现的上一版欠账 |
|---|---|---|
| 1.0 | 网页翻译 MVP | — |
| 2.0 | 能用 → 好用、广用 | Native Host、站点兼容、划词 |
| 3.0 | HTML → 全部内容 | PDF / 图片 / 字幕 + 体验收口 |
| 4.0 | 可见 → 可听、可装 | ASR、网关多模态、tesseract、Firefox MVP |
| **4.1** | **欠账收口** | **TM、OCR 语言包、Firefox 网关；流式/覆盖/双栏视进度** |

---

## 3. 4.1 版本目标

### P0

1. 设置 schema v5 与自动迁移（v4 → v5 只补默认值；v5 可被 4.0 `normalizeSettings` 安全读取）；
2. **句子级 TM**：独立 IndexedDB 表；默认关闭；归一化精确匹配命中则跳过 Provider；
   环形 5000；成功译文（源句 8–240 字）写入；Options 可清空；配置导出不含 TM；
3. **OCR 附加语言包下载器**：Options 列出可下载包（数据文件）；勾选后显示体积并下载到
   IndexedDB blob 或 `%LocalAppData%\PolyPage\tessdata\`；失败可重试；识别时与默认
   `eng`/`chi_sim` 一并交给 tesseract；
4. **Firefox Native Messaging 真联调**：临时加载 `dist-firefox/` 后，`connectNative`
   ping 成功且至少一笔 `translate` 经网关返回；失败则 failover + Options 说明原因，
   不得未捕获异常；
5. 上述三项的单元测试 + 冒烟 / 手动清单（见 §12）。

### P1

1. **ASR 流式 cue**：后端若提供分段 / streaming transcription，边转写边往 3.0 字幕层
   注入 cue；不支持则保持 4.0「一次转写完再出」；
2. **图片原位覆盖简单版**：在原图上叠半透明底 + 译文（用户可关，回到 4.0 结果面板）；
   复杂版面、竖排、弯曲文字不承诺。

### P2

1. **PDF 双栏 / 表格聚类专项**：在 3.0/4.0 启发式上增加按文档类型可调参数
   （或 Options 预设「单栏 / 双栏 / 偏表格」），不重写阅读器。

VALIDATION-4.0 §8 六条到此全有归属。

---

## 4. 4.1 非目标

延续 4.0 §4，并明确本版仍不做：

1. 账号系统、云端配置同步、多用户配额；
2. 可视化拖拽站点规则编辑器；
3. 自动更新服务端、语言包自动升级；
4. 企业审计与集中管控；
5. 移动端、Safari、Firefox AMO 上架、Chrome Web Store「已上架」；
6. PDF 编辑器 / 写回源文件；
7. 图片像素级版面还原、字体重建；
8. 破解 DRM；申请麦克风 / `tabCapture` / 会议口译 / 输入框实时翻译；
9. 随插件分发 Whisper 权重或默认两包之外的 tesseract 训练数据；
10. **SRT/VTT 导出**、再收高流量自绘字幕站点（4.0 P2 未升入 4.1）；
11. 新开实时协作、云 TM、跨设备记忆。

---

## 5. 支柱 M：句子级翻译记忆（TM）

兑现 4.0 §7.4，不再是「只留字段」。

### 5.1 与缓存的边界

| | 翻译缓存（已有） | TM（4.1） |
|---|---|---|
| 键 | 文本哈希 + 语言对 + glossaryVersion [+ 引擎] | 归一化后的整句哈希 + 语言对 |
| 默认 | 开 | **关** |
| 用途 | 同页/跨页完全相同输入免调用 | 跨页整句复用（空白折叠，可选去首尾标点） |
| 存储 | 现有 cache | 独立 IndexedDB 表 |

术语表仍走 Prompt，不与 TM 合并。

### 5.2 存储

- 表名建议 `tm`；环形上限默认 5000（沿用 `translationMemory.maxEntries`）；
- 条目：`{ hash, source, target, langPair, hits, ts }`；
- **不含 URL**、不含页面标题；
- 配置导入/导出 **不包含** TM 表。

### 5.3 读写

1. 后台在组批发给 Provider **之前**查 TM；整批或部分命中则只请求未命中项；
2. `enabled === false` 时不读不写；
3. 写入：成功翻译且源句 trim 后长度 8–240（字符）才入表；更新 `hits`/`ts`；
4. 淘汰：超过 `maxEntries` 按最旧 `ts`（或最少 `hits` 再最旧，实现选定一种并单测钉死）；
5. Options：「启用句子记忆」「上限」「清空」；清空需二次确认。

### 5.4 归一化

默认：`NFKC` + 折叠连续空白为单空格 + trim。
「去首尾标点」作为实现细节可默认开启，须在单测中固定样例（`Hello, world!` 与
`Hello, world` 视为同一句）。不要做模糊 / 词干 / 嵌入检索。

---

## 6. 支柱 N：OCR 附加语言包

兑现 4.0 §7.5。

### 6.1 默认与增量

- 构建期仍只打包 `vendor/tessdata/eng` + `chi_sim`（哈希校验不变）；
- 附加包视为**数据**，用户在 Options「OCR 语言包」勾选后下载；
- 4.1 至少支持一份文档化清单（例如 `jpn` / `kor` / `fra` / `deu`，以
  tessdata_fast 官方或项目写死的镜像为准）；未列出的语言 4.1 不做任意 URL。

### 6.2 存储位置

优先顺序（实现选一，文档写死）：

1. IndexedDB blob（扩展内，卸载即走）；或
2. `%LocalAppData%\PolyPage\tessdata\`（网关或扩展能读到的用户目录）。

禁止塞进 `chrome.storage.local`。下载中显示进度；失败保留错误并可重试；不自动更新。

### 6.3 UI 与隐私

- 勾选前必须看到「将下载第三方 OCR 数据，约 x MB」；
- 已下载可删除；
- `imageTranslate.tessLangs`（或 v5 等价字段）只包含用户启用且已就绪的包 + 默认两包。

### 6.4 识别

tesseract 引擎把已就绪语言拼进 `lang`；缺包时降级到已有包并提示，不抛未捕获异常。
扫描 PDF「识别本页」走同一套语言选择。

---

## 7. 支柱 O：Firefox 网关真联调

### 7.1 退出标准

在 Firefox 稳定版临时加载 `dist-firefox/` 后：

1. Options 显示网关「已连接」或等价状态（`ping` / `health` 成功，`protocol === 2`）；
2. 至少一笔网页文本经 `native-host` Provider 得到译文（可用本机 Ollama 或测试 stub）；
3. 未安装 / 键不对 / `connectNative` 失败时：视为未安装，走 failover，Options
   「浏览器兼容」写明原因，控制台无未捕获异常。

### 7.2 工程

- 安装器 4.0 已写 `Software\Mozilla\NativeMessagingHosts` 与
  `{HostName}.firefox.json` 的 `allowed_extensions: ["polypage@skymly.com"]`；
  4.1 核对这些字段与当前 gecko.id 一致，缺则补，不要另搞一套 ID；
- 代码继续只写 `chrome.*`；连接失败必须特性检测；
- 无头 Firefox 若不稳定，允许「手动清单 + 安装器/manifest 单测」为自动退出，
  但手动清单必须在 `docs/VALIDATION-4.1.md` 勾过第 7.1 三条。

### 7.3 不做

AMO 上架、Linux/macOS 安装路径、Firefox Android。

---

## 8. P1 / P2 规格要点

### 8.1 ASR 流式 cue（P1）

- 仅当 Provider / 网关能力声明支持分段或 streaming 时启用；
- 增量 cue 复用 `CueScheduler`；关闭仍零残留；
- 不支持则行为与 4.0 完全一致（一次注入）；
- 仍不申请麦克风；仍不写 SRT（除非用户以后单独立项）。

### 8.2 图片原位覆盖（P1）

- 默认关或与结果面板并存（实现选「设置开关，默认关」以免吓到用户）；
- 叠在原图上的半透明层 + 若干译文块，框大致按 OCR 片段；
- 用户可一键回到面板模式；关闭翻译即卸层；
- 不承诺多栏海报、印章、手写。

### 8.3 PDF 双栏 / 表格（P2）

- 不重写 `viewer/pdf/segment.ts` 架构；
- 增加可调参数或少量预设，单测钉住「双栏夹具不再左右串段」的至少一个回归样例；
- 做不到完美则在阅读器保留「按行」回退。

---

## 9. 架构演进

### 9.1 模块增量

| 模块 | 变化 |
|---|---|
| storage | ★ `tm.ts`：查表 / 写入 / 环形 / 清空；settings schema v5 |
| background | 组批前 TM 查询；语言包下载任务；命中统计可进 session stats |
| ocr | 语言包加载器；tesseract `lang` 拼装 |
| options | TM 开关/清空；OCR 语言包列表/进度；Firefox 网关状态文案 |
| native-host | 仅核验 Firefox manifest / 键；协议仍为 v2 |
| content / ocr/resultPanel | P1：可选原位覆盖层 |
| asr / media | P1：流式 cue 注入 |
| viewer/pdf/segment | P2：可调聚类参数 |
| docs | `VALIDATION-4.1.md` |

### 9.2 消息协议

- RuntimeMessage 标记 `v: 5`（缺省按低版本处理，4.0 内容脚本仍可用）；
- 新增（可内部使用）：`tm-clear`、`tm-stats`、`ocr-pack-download` /
  `ocr-pack-progress` / `ocr-pack-remove`；
- 无新的「绕过队列」翻译 API。

### 9.3 设置 schema v5

`schemaVersion: 5`。v4 → v5 只补默认：

```ts
translationMemory: { enabled: false; maxEntries: 5000 }; // 已在 v4，保持
ocrPacks: {
  extraLangs: string[];     // 用户启用的附加语言 id，默认 []
};
imageOverlay: {
  enabled: boolean;         // 默认 false
};
asr: {
  // v4 字段保留
  streaming: boolean;       // 默认 false；后端不支持时忽略
};
pdfViewer: {
  // 保留
  layoutPreset?: 'auto' | 'single' | 'columns' | 'table'; // 默认 auto；P2 才用
};
```

v5 可被 4.0 代码读取（未知字段忽略）。补 `migration5.test.ts`。

### 9.4 权限

无新增必选权限。语言包下载走 HTTPS 到写死的源，不申请无限下载特权。
Firefox 包权限面与 4.0 一致。

---

## 10. 推荐目录结构（4.1 增量）

```text
src/storage/tm.ts                 # ★ P0 TM
src/ocr/packs.ts                  # ★ P0 语言包清单 / 下载 / 删除
src/ocr/overlay.ts                # P1 原位覆盖
docs/VALIDATION-4.1.md            # 交付时
PolyPage-4.1.md                   # 本文件
```

4.0 目录其余保持。不要为 TM 新建 Provider 类型。

---

## 11. 里程碑与阶段安排

延续里程碑编号（M1–M9 已交付）。每阶段结束：可加载 + 4.0 回归门槛零回退。

### M10 —— schema v5 + TM（支柱 M）

1. v4→v5 迁移与 v5→v4 读兼容测试；
2. `storage/tm.ts` + 后台查表/写入；
3. Options 开关 / 清空；
4. 冒烟：同句第二页（或第二 fixture）命中则 mock Provider 调用次数不增加。

退出：TM 单测（归一化命中 / 未命中 / 环形 / 关闭不写）全绿；4.0 单测与冒烟基线零回退。

### M11 —— 语言包 + Firefox 网关（支柱 N + O）

1. Options 语言包清单、体积声明、下载/删除、识别用上新包（可用 stub 包 + 哈希）；
2. Firefox 临时加载后 ping + 一笔 native-host 翻译，或失败 failover 文案；
3. 安装器 gecko.id / Mozilla 键回归测试。

退出：语言包失败重试单测通过；VALIDATION-4.1 手动项勾上 Firefox 网关三条之一
（成功或明确降级）。

### M12 —— P1 收口 + 余项

1. 流式 cue（有能力才启用）；
2. 图片原位覆盖开关；
3. 双栏专项若来不及，写入 VALIDATION-4.1 §遗留。

允许再顺延 4.2 的仅限：双栏专项、流式 cue（若无后端）、原位覆盖精修。
P0 三项不得顺延。

---

## 12. 验收与验证要求

1. **单元**：v4→v5 迁移；TM 归一化 / 命中 / 淘汰 / 关闭；语言包清单与失败重试；
   安装器 Firefox manifest 字段（若可在 Node/.NET 测）。
2. **冒烟（无头 Edge）**：4.0 断言零回退；TM 开启时第二页同句零新增 mock 调用；
   导航菜单 `原文[译文]` 仍在。
3. **手动**：Firefox 网关 7.1；可选——用户本机若有视觉/Whisper，记入 VALIDATION-4.1，
   没有则保持「待手动 / 无权重」。
4. **回归门槛**：`tsc --noEmit` 0 错误；4.0 单测全集保留通过；网关 xunit / stdio
   旧项全绿（协议仍为 2）。

---

## 13. 风险与权衡

| 风险 | 处理 |
|---|---|
| TM 误命中改写术语 | 默认关；精确匹配 + 语言对；不含模糊检索 |
| 语言包 CDN 失效 / 体积大 | 写死 URL + 哈希；显著声明；失败可删可重试 |
| Firefox Native Messaging 策略差异 | 失败即降级；不把「Firefox === Chrome」当退出条件 |
| 流式后端不统一 | 无能力则完全走 4.0 路径 |
| 原位覆盖破坏页面 | 默认关；关闭即卸层 |
| 双栏启发式继续翻车 | P2；保留按行回退 |

---

## 14. 术语表（4.1 新增 / 重申）

| 术语 | 含义 |
|---|---|
| TM | 句子级翻译记忆，跨页精确复用，默认关 |
| 语言包 | tesseract `.traineddata` 数据文件，非可执行代码 |
| 真联调 | Firefox 进程内 `connectNative` 往返，不只是注册表键存在 |
| 原位覆盖 | 叠在图片上的译文层，不是写回文件 |
| schema v5 | 4.1 设置版本；只增默认，4.0 可忽略新字段 |
