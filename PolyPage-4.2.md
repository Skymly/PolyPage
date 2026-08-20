# 项目规划文档：网页翻译浏览器插件 4.2

## 0. 给 Agent 的总指令

本文档是 **4.2 版本的规划文档**，基于 `PolyPage.md`（1.0）、`PolyPage-2.0.md`、
`PolyPage-3.0.md`、`PolyPage-4.0.md` 与 `PolyPage-4.1.md` 制定。
4.1 已交付并收口（schema v5、消息协议 v5、句子 TM、OCR 语言包、Firefox 安装器键、
原位覆盖简单版、PDF 版面预设、MiniMax 视觉真机；2026-08-18 记入
`docs/VALIDATION-4.1.md`）。仓库当前主线为 `main` @ 4.1.0。

4.2 的主题是：

> **不另开大功能。把译文洗干净，把 Firefox 网关最后一公里走完，
> 把 4.1 允许顺延的精修做实。**

三大 P0 支柱（延续字母编号）：

1. **支柱 P：译文卫生（output hygiene）** —— 兑现 VALIDATION-4.1 §4
   「qwen3 / MiniMax 思考链污染译文」；文本管线与视觉管线同一套剥离；
2. **支柱 Q：Firefox 网关进程内收口** —— 兑现 VALIDATION-4.1 §2.7.1 未勾项
   与 4.1 §7.1；Marionette / 隔离 profile 自动化，不再只靠注册表键；
3. **支柱 R：流式 cue 与覆盖 / 版面精修** —— 兑现 4.1 §11「允许再顺延 4.2」
   的三项，有能力才启用，无能力不得假装做成。

VALIDATION-4.1 §4 其余项不得 silently drop：真实 Whisper 仍受本机权重限制，
**不是 4.2 P0 退出条件**，但须在 VALIDATION-4.2 记「有 / 无权重」。

请严格遵循以下原则：

1. **4.1 功能零回退**：六种网页显示模式、导航菜单 `原文[译文]`、PDF / OCR /
   字幕 / ASR / TM / 语言包、消息协议 v5 可读、设置 schema v5 可读、
   网关协议 v2 只增不改；
2. 每个里程碑产出可加载、可运行、可验证的扩展（延续 1.0 原则 10）；
3. 卫生剥离、流式 cue、覆盖一律走现有后台管线，禁止另开旁路翻译 API；
4. 思考链剥离 **默认开启**；用户可在 Options 关掉以查看原始模型输出；
5. 不随插件分发 Whisper 权重或默认两包之外的 `.traineddata`；
6. 不破坏原始内容：不改 PDF / 视频源；覆盖仍是叠层；
7. 设置升级必须自动迁移（schemaVersion 5 → 6），不得破坏 4.1 用户配置；
   v6 必须仍能被 4.1 `normalizeSettings` 安全读取（忽略未知字段）；
8. 每项新功能补对应层级验证（单元 / 冒烟 / Firefox 手动或 Marionette）；
9. 仍以 Chrome / Edge 为发行主线，Manifest V3；**无新增必选权限**，不申请麦克风；
10. 敏感信息纪律不变：API Key 只在后台 / 本机网关；TM 不含 URL；
    环境变量里的 Token Plan key 不得写入仓库、日志或 VALIDATION 全文。

---

## 1. 项目名称

Web Translator Extension **4.2**

可简称为：

> Web Translator 4.2 / PolyPage 4.2

版本号：`package.json` / `manifest.json` / 网关 `Version` 升为 **4.2.0**。
网关 `ProtocolVersion` **保持 2**（若新增可选 RPC，只增不改）。

---

## 2. 与 4.1 的关系

1. 4.1 的 TM、语言包、覆盖开关、PDF `layoutPreset`、MiniMax 预设全部保留，
   不推倒重来；
2. 4.1 视觉路径已剥 `<think>`，**文本路径仍可能把思考链当译文**
  （Ollama qwen3 真机已复现）—— 4.2 P0 兑现到统一卫生层；
3. 4.1 Firefox：安装器键与 gecko.id 已齐，**进程内 `connectNative` 未勾上**
   —— 4.2 P0 用隔离 profile + Marionette（或等价）自动化，不依赖 Computer Use
   驱动已打开的用户 Firefox；
4. 4.1 P1 流式 cue 只做了「无后端则忽略」—— 4.2 在有 `transcribeStream` /
   分段通知时必须真注入；无后端则行为与 4.1 完全一致；
5. 4.1 原位覆盖 / 双栏预设是简单版 —— 4.2 精修，不重写阅读器、不承诺海报级还原；
6. 4.1 已完成且 4.2 **不要重做**的：TM 本体、语言包下载器、tesseract-wasm、
   MiniMax 视觉夹具通路、商店三份材料、schema v5 迁移测试；
7. 「真实 Whisper / 真实视觉」仍受本机或云端能力限制。视觉已有 MiniMax Token
   Plan 通路；Whisper 无权重则保持「待手动 / 无权重」，**不是退出条件**；
8. 演进对照：

| 版本 | 主题 | 兑现的上一版欠账 |
|---|---|---|
| 1.0 | 网页翻译 MVP | — |
| 2.0 | 能用 → 好用、广用 | Native Host、站点兼容、划词 |
| 3.0 | HTML → 全部内容 | PDF / 图片 / 字幕 + 体验收口 |
| 4.0 | 可见 → 可听、可装 | ASR、网关多模态、tesseract、Firefox MVP |
| 4.1 | 欠账收口 | TM、OCR 语言包、Firefox 键；流式/覆盖/双栏起步 |
| **4.2** | **洗干净、走完、精修** | **思考链剥离、Firefox 进程内网关、流式/覆盖/版面精修** |

不要开 5.0。1.0→4.0 的大台阶（网页 → 全内容 → 可听可装）已走完；
账号云同步、企业管控、移动端仍在非目标里。

---

## 3. 4.2 版本目标

### P0

1. 设置 schema v6 与自动迁移（v5 → v6 只补默认值；v6 可被 4.1 `normalizeSettings`
   安全读取）；
2. **统一译文卫生层**：所有走后台队列的成功译文（网页 / 划词 / cue / PDF /
   OCR 两步法）在展示与写入缓存 / TM **之前**剥离：
   - `<think>…</think>` / `</think>` 残片；
   - MiniMax / 部分模型的 `reasoning_content` 不得误当作 `content`；
   - 可选剥代码围栏（与现有 `stripCodeFences` 对齐）；
   默认开；Options 可关；单测钉死 qwen3 / MiniMax 样例；
3. **Firefox 进程内网关**：隔离 profile + 临时加载 `dist-firefox/` 后，
   `host-status` 显示已连接（`protocol === 2`）且至少一笔 `native-host`
   翻译返回；失败则 failover + Options 原因，控制台无未捕获异常。
   Computer Use 驱动用户已开的 Firefox **不是**退出条件；
4. MiniMax Token Plan 预设保持 `api.minimax.chat`；`sk-cp-` 误指 `.io` 时
   Options / 错误文案须提示换 host（不得在日志打印 key）；
5. 上述各项的单元测试 + 冒烟 / 自动联调脚本（见 §12）。

### P1

1. **ASR 流式 cue 真启用**：仅当 Provider / 网关声明支持分段或
   `transcribeStream` 时，边转写边往 3.0 字幕层注入 cue；关闭仍零残留；
   不支持则与 4.1 完全一致；
2. **图片原位覆盖精修**：框随滚动 / 视口变化重算；关闭翻译或关开关即卸层；
   仍不承诺竖排、弯曲、多栏海报；
3. MiniMax / OpenAI-compatible 视觉路径回归：`minimax-live-check.mjs` 保留为
   手动/可选 CI，不把云端 key 写进仓库。

### P2

1. **PDF 表格 / 复杂双栏**：在 4.1 `layoutPreset` 上再钉至少 1 个表格夹具
   「单元格不与左右栏串段」；做不到完美则阅读器保留按行回退；
2. 纯 `<audio>` 字幕条（4.0 备注：自绘层目前挂在 video 上）—— 有余力再做。

VALIDATION-4.1 §4 到此全有归属。

---

## 4. 4.2 非目标

延续 4.1 §4，并明确本版仍不做：

1. 账号系统、云端配置同步、多用户配额、云 TM、跨设备记忆；
2. 可视化拖拽站点规则编辑器；
3. 自动更新服务端、语言包自动升级；
4. 企业审计与集中管控；
5. 移动端、Safari、Firefox AMO 上架、Chrome Web Store「已上架」；
6. PDF 编辑器 / 写回源文件；
7. 图片像素级版面还原、字体重建、复杂海报 OCR 排版；
8. 破解 DRM；申请麦克风 / `tabCapture` / 会议口译 / 输入框实时翻译；
9. 随插件分发 Whisper 权重或默认两包之外的 tesseract 训练数据；
10. **SRT/VTT 导出**、再收高流量自绘字幕站点（4.0 P2，4.1/4.2 都不升）；
11. 新开 5.0 级题材（协作、多用户、移动端）。

---

## 5. 支柱 P：译文卫生

### 5.1 问题

4.1 真机：

- Ollama `qwen3-14b-64k` 会把 thinking / `</think>` 写进页面译文；
- MiniMax-M3 默认 thinking 开；4.1 已对 MiniMax 请求关 thinking，并对视觉
  JSON 剥 `<think>`，但文本 `translateTexts` / 缓存 / TM 仍可能吃进残片。

### 5.2 卫生层（纯函数，单测钉死）

建议 `src/shared/sanitize.ts`（名称可改，须可单测）：

1. 删除成对 `<think>…</think>`（大小写不敏感，含未闭合到文末）；
2. 删除残留的 `</think>` / `<think>`；
3. 可选：`stripCodeFences`；
4. trim；若剥完为空则视为 `invalid_response`，不得把空串写入 TM / 缓存。

调用点：后台 `runBatch` / `translate-cue` / OCR 两步法译文落盘前。
内容脚本不做二次「创造性」改写。

### 5.3 设置

```ts
outputSanitize: {
  enabled: boolean;      // 默认 true
  stripThink: boolean;   // 默认 true
  stripCodeFences: boolean; // 默认 false（避免误伤合法围栏译文）
};
```

`enabled === false` 时完全不剥，便于排障。

### 5.4 与 Provider 侧开关的关系

- 本地 Ollama：继续传 `think: false`（4.1 已有）；
- MiniMax：继续传 `thinking: { type: "disabled" }`；
- 卫生层是 **最后一道闸**，不替代上述请求参数。

---

## 6. 支柱 Q：Firefox 网关进程内收口

### 6.1 退出标准（相对 4.1 收紧）

在 **隔离 profile**（不得附加到用户正在用的 Firefox）临时加载
`dist-firefox/` 后：

1. Options / `host-status`：`installed === true` 且 `protocol === 2`；
2. 至少一笔网页文本经 `native-host` 得到译文（本机 Ollama、网关 stub 或
   MiniMax 均可，记入 VALIDATION-4.2）；
3. 键不对 / `connectNative` 失败：视为未安装，failover，Options「浏览器兼容」
   写明原因，无未捕获异常。

4.1 已满足的安装器 / gecko.id 单测必须继续绿。

### 6.2 工程

- 优先 `scripts/firefox-gateway-check.mjs`（或后继）：独立 profile、
  `--marionette`、独立端口、`Addon:Install` 临时加载、再从扩展页发
  `host-status` / `translate`；
- 不得依赖 Computer Use 操作用户已打开的窗口；
- 无头若仍不稳：VALIDATION-4.2 勾上手动 6.1 三条之一（成功或明确降级），
  **但脚本必须能在干净机器上复现安装与加载**；
- 不另搞 gecko.id。

### 6.3 不做

AMO 上架、Linux/macOS 安装路径、Firefox Android。

---

## 7. 支柱 R：流式 cue 与覆盖 / 版面精修

### 7.1 ASR 流式 cue（P1）

- 仅当能力声明支持时启用；增量 cue 复用 `CueScheduler`；
- `asr.streaming === false` 或后端无能力：与 4.1 一次注入完全一致；
- 仍不申请麦克风；仍不写 SRT。

### 7.2 原位覆盖精修（P1）

- 默认仍关；
- 滚动 / resize 后 bbox 按图片当前 `getBoundingClientRect` 重算；
- `wt:restore` 与关开关必须卸层（4.1 已有，回归不得破）；
- 复杂版面继续不承诺。

### 7.3 PDF 表格 / 双栏（P2）

- 不重写 `viewer/pdf/segment.ts` 架构；
- 至少新增 1 个表格或「短双栏 + 表头」夹具；
- 失败则按行回退，写入 VALIDATION-4.2 §遗留即可。

---

## 8. P2 以外的 4.1 余项归属

| VALIDATION-4.1 §4 | 4.2 归属 |
|---|---|
| Firefox 进程内 connectNative | 支柱 Q / P0 |
| qwen3 思考链污染译文 | 支柱 P / P0 |
| 原位覆盖复杂版面 | 支柱 R 精修；仍不承诺完美 |
| PDF 表格启发式上限 | 支柱 R P2；允许再记遗留 |
| 真实 Whisper 无权重 | 非退出条件；VALIDATION 记一笔 |

---

## 9. 技术选型与架构约束

### 9.1 模块增量

| 模块 | 变化 |
|---|---|
| shared | ★ `sanitize.ts`：思考链 / 残片剥离 |
| storage | settings schema v6；`outputSanitize` 默认 |
| background | 写缓存 / TM 前过卫生层 |
| providers/openai-compatible | 保持 think / thinking 关闭；卫生层在其后 |
| options | 卫生开关；MiniMax host 提示 |
| content / ocr/overlay | P1：滚动重算 |
| asr / media | P1：真流式注入 |
| viewer/pdf/segment | P2：多一个夹具 |
| scripts | Firefox 隔离 profile 联调；保留 minimax / ollama live |
| docs | `VALIDATION-4.2.md` |

### 9.2 消息协议

- RuntimeMessage 标记 `v: 6`（缺省按低版本处理，4.1 内容脚本仍可用）；
- 无新的「绕过队列」翻译 API；
- 流式 ASR 若需增量，优先复用 4.1 已留的 `wt:asr-partial`。

### 9.3 设置 schema v6

`schemaVersion: 6`。v5 → v6 只补默认：

```ts
outputSanitize: {
  enabled: true;
  stripThink: true;
  stripCodeFences: false;
};
```

其余 v5 字段保留（`ocrPacks` / `imageOverlay` / `asr.streaming` /
`pdfViewer.layoutPreset`）。v6 可被 4.1 代码读取（未知字段忽略）。
补 `migration6.test.ts`。

### 9.4 权限

无新增必选权限。Firefox 包权限面与 4.1 一致。

---

## 10. 推荐目录结构（4.2 增量）

```text
src/shared/sanitize.ts              # ★ P0 卫生层
tests/sanitize.test.ts
tests/migration6.test.ts
scripts/firefox-gateway-check.mjs   # ★ P0 隔离 profile 真联调（迭代现有稿）
docs/VALIDATION-4.2.md              # 交付时
PolyPage-4.2.md                     # 本文件
```

4.1 目录其余保持。不要为卫生层新建 Provider 类型。

---

## 11. 里程碑与阶段安排

延续里程碑编号（M1–M12 已交付）。每阶段结束：可加载 + 4.1 回归门槛零回退。

### M13 —— schema v6 + 卫生层（支柱 P）

1. v5→v6 迁移与 v6→v5 读兼容测试；
2. `sanitize.ts` + 后台落盘前调用；
3. Options 开关；
4. 冒烟或单测：带 `<think>` 的 mock 回复不得出现在页面 / TM。

退出：卫生单测全绿；4.1 单测与冒烟基线零回退。

### M14 —— Firefox 进程内网关（支柱 Q）

1. 隔离 profile Marionette（或等价）临时加载 `dist-firefox/`；
2. `host-status` + 至少一笔 native-host 翻译，或明确降级文案；
3. 安装器 gecko.id 回归保持绿。

退出：VALIDATION-4.2 勾上 §6.1 三条之一（成功或明确降级），且脚本可复现加载。

### M15 —— 流式 / 覆盖 / 版面（支柱 R）

1. 有能力则流式 cue；
2. 覆盖随滚动重算；
3. 表格夹具若来不及，写入 VALIDATION-4.2 §遗留。

允许再顺延 4.3 的仅限：表格聚类完美化、纯 audio 字幕条、SRT 导出（若以后单独立项）。
P0 两项（卫生、Firefox 进程内）不得顺延。

---

## 12. 验收与验证要求

1. **单元**：v5→v6 迁移；卫生层样例（qwen3 残片、MiniMax 围栏 JSON、剥完为空）；
   安装器 Firefox 字段保持。
2. **冒烟（无头 Edge）**：4.1 断言零回退；带 think 的 mock 译文不含 `<think>`；
   导航菜单 `原文[译文]` 仍在；TM 第二页零新增 mock 仍在。
3. **联调脚本**：`firefox-gateway-check.mjs`（隔离 profile）；可选
   `ollama-live-check.mjs` / `minimax-live-check.mjs`（key 仅环境变量）。
4. **回归门槛**：`tsc --noEmit` 0 错误；4.1 单测全集保留通过；网关 xunit /
   stdio 旧项全绿（协议仍为 2）。

---

## 13. 风险与权衡

| 风险 | 处理 |
|---|---|
| 误剥合法译文里的 `<think>` 字面量 | 只剥标签对；默认开但可关；单测钉合法句子 |
| 剥完变空被当成成功 | 视为 invalid_response，不写 TM/缓存 |
| 用户 Firefox 已开导致 Marionette 抢实例 | **必须** `--no-remote` + 独立 profile + 独立端口 |
| Computer Use 仍不能点 Firefox | 不作为退出条件 |
| 流式后端仍不统一 | 无能力则完全走 4.1 |
| 覆盖随滚动抖动 | rAF 合批；关开关即卸 |
| 表格启发式继续翻车 | P2；按行回退 |

---

## 14. 术语表（4.2 新增 / 重申）

| 术语 | 含义 |
|---|---|
| 卫生层 | 展示与落盘前的思考链 / 残片剥离，默认开 |
| 隔离 profile | 专为联调新建的 Firefox 配置目录，不碰用户日常 profile |
| 进程内网关 | 扩展进程 `connectNative` 往返，不只是注册表键 |
| schema v6 | 4.2 设置版本；只增默认，4.1 可忽略新字段 |
| 真流式 cue | 后端分段到达即注入字幕层；不是一次转写完再出 |

