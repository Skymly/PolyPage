# PolyPage 3.0 验证记录

日期：2026-08-13　环境：Windows（开发机）、Node v24、.NET SDK 10（网关 net8.0，
3.0 未改动网关代码）、Edge headless（`--headless=new`）、pdfjs-dist 4.10.38
（vendor 本地打包，构建期 SHA-256 校验）。

对照 `PolyPage-3.0.md` §11 里程碑退出标准与 §12 验收要求。

---

## 1. 回归门槛（§12.4）

| 项 | 2.0 基线 | 3.0 结果 |
|---|---|---|
| strict TypeScript | 0 错误 | **0 错误** |
| 2.0 单元测试 | 83 通过 | **83/83 保留通过**（合计 163） |
| 2.0 冒烟断言 | 61 通过 | **61/61 保留通过**（合计 103） |
| 网关 xunit 契约 | 28 通过 | **28/28 原样通过**（3.0 未改网关代码） |
| 网关真实进程 stdio 契约 | 9 通过 | **9/9 原样通过** |

## 2. 单元测试（§12.1）— 163 个全部通过

2.0 的 8 个测试文件（83 个）全部保留通过，其中 `migration.test.ts` 扩展为
v1→v3 迁移断言（9 个）。3.0 新增 9 个文件 79 个用例 + 迁移扩展 1 个：

- `tests/pdfSegment.test.ts`（16，支柱 E）：行分组与大间隙拆段、**行距换段**、
  **字号（标题）换段**、**连字符断行合并**（含大写保留）、CJK 无空格拼接、
  **页码过滤**（数字/罗马/Page N/第 N 页）、**跨页重复页眉页脚收集与过滤**、
  skipHeadersFooters 全局开关、**双栏重排（先左栏整列后右栏 + 栏间强制换段）**、
  扫描页判定（空/纯空白/正常）；
- `tests/fingerprint.test.ts`（7）：meta 指纹确定性、分量变更敏感性、缺省字段容忍、
  文件 ID 优先 / 回退 meta、**缓存键 = 指纹+页+序号+文本 的稳定性与语言对/术语表
  版本参与**（§5.5.2）；
- `tests/vision.test.ts`（12，支柱 F）：结构化 Prompt（JSON 数组约束、语言对、
  **{{glossary}} 注入**）、`buildVisionRequest` **image_url 载荷**、畸形响应归因
  （空/无 JSON/坏 JSON/空数组/缺 text → `invalid_response`）、围栏与替代键名容忍、
  无视觉能力 Provider 拒绝、provider.translateImage 往返；
- `tests/imageDownsample.test.ts`（9）：**超限/恰好/超限回退底线**（边长与字节
  双维度，IMAGE_MAX_BYTES=8MB）；
- `tests/cueSchedule.test.ts`（12，支柱 G）：VTT/ASS 标签剥离、活跃 cue 查找
  （边界排他）、**激活→fetch、在途不重发、解决后展示、切换→fetch、重复 cue
  缓存命中、失败冷却重试、reset 还原**（§7.1 关闭即还原）；
- `tests/languageDetect.test.ts`（7，支柱 H）：**12 语言样本语料 100% 判定**
  （zh/en/ja/ko/ru/es/fr/de/it/pt/nl/ar，要求 ≥90%）、空输入、无停用词拉丁文本
  不强行判定、多样本投票置信、script 计数；
- `tests/migration3.test.ts`（6，§9.3）：**v2→v3 只补默认值且逐字段保留**、
  部分 3.0 字段宽容归一化（钳制）、**subtitleSelectors 归一化**、**v3 文档可被
  2.0 式归一化安全读取**（v3→v2 读兼容，延续 2.0 对 1.0 的同款保证）；
- `tests/taskTable.test.ts`（6，§8.4）：任务记录含 textHash、inflight 列表按时序、
  **markDone 幂等**、跨 tab 不误删、**tabs.onRemoved 清理语义**、**5000 条环形淘汰**；
- `tests/feedback.test.ts`（4，§8.2）：环形上限 200 契约、CSV 转义（逗号/引号/换行）、
  表头与行格式、空日志。

## 3. 冒烟测试（§12.2）— 103 项断言全部通过

`npm run smoke`（无头 Edge + mock API + 真实网关）：

- **2.0 用例零回退（61 项）**：六模式/悬停/恢复、站点规则、inline、Shadow DOM、
  iframe 聚合、划词、SSE 流式、导出、取消语义、真实 .NET 网关与故障转移；
- **schema v3（3 项）**：v2 载荷经真实 save-settings 落盘为 schemaVersion 3、
  四个支柱分区默认值齐全；
- **语言检测与守护（4 项）**：英文夹具页 pageLanguage=en、目标语言=英语时
  自动翻译被跳过（autoSkipped）且零双语块；
- **质量反馈（3 项）**：双语块悬停出现「标记坏句」→ 点击 → 反馈日志记录
  （原文/译文/where=page）；
- **划词增强（3 项）**：Alt+Q 命令路径 `wt:repeat-selection` 无选区重放上次结果
  面板、面板新增朗读+标记按钮；
- **图片 OCR（9 项）**：≥200px 悬停按钮出现 → 点击 → mock vision 端点**恰好一次**
  → 面板结构化片段（Shadow DOM 隔离）→ 关闭再触发**缓存命中零新调用** →
  切换无视觉 Provider 后 visionSupported=false、按钮置灰含原因、点击不弹面板；
- **视频字幕（5 项）**：`<track>` 接管（track.mode=hidden 不删除）、双 cue WebVTT
  自绘层双语渲染（原文+`[译]`）、**cue 切换**、关闭后字幕层移除 + track.mode
  还原 showing（零残留）；
- **PDF 阅读器（7 项）**：本地伺服 4 页夹具 PDF（双段/页眉/页码/扫描占位页）
  经阅读器页全流程：聚类段落经后台管线译出、**页眉+页码被过滤**、扫描页提示、
  进度条、canvas 渲染、**关闭重开零 API 调用（文档指纹缓存命中）**；
- **续译（4 项）**：慢速端点在途时**经 CDP 杀死 SW 目标** → 运行时消息唤醒新 SW →
  任务表驱动 `wt:resume-inflight` → 全部段落最终完成（缓存幂等）。

夹具（§12.2 要求）：程序生成的合法多页 PDF（精确 xref）、1×1 PNG + mock vision
端点（固定报文）、video + WebVTT 双 cue 页（时间驱动）、续译 SW 重启场景。

## 4. 网关（§2.2 第 9 条：3.0 默认不改动）

- `native-host/` 源码与协议零改动；
- `dotnet test`：28 个 xunit 契约测试全绿；
- `scripts/gateway-contract-test.mjs`：真实发布进程 stdio 帧 9 项全绿；
- 冒烟网关阶段：host-status、经真实网关翻译（`[gw]`）、缺失 host 故障转移
  回退云端、日志归因、actualProvider 提示 — 全部通过。

## 5. 构建与打包

- `scripts/build.mjs` 六段构建：popup / options / **viewer** / background /
  content / **vendor 校验**；viewer 独立 HTML 入口，pdf.js 仅阅读器页懒加载
  （`import(/* @vite-ignore */ chrome.runtime.getURL('vendor/pdf.min.mjs'))`，
  已验证产物保留动态导入）；
- `vendor/` pdf.js 4.10.38 发行版：`scripts/vendor-hashes.json` 钉住
  SHA-256（pdf.min.mjs `27fc2a05…`、pdf.worker.min.mjs `1baa1844…`），
  构建期逐文件校验，漂移即拒绝构建；`scripts/sync-vendor.mjs` 升级后重钉；
- 内容脚本体积未受 pdf.js 影响（content.js ≈ 59KB，pdf.js 仅在 dist/vendor/）。

## 6. 里程碑退出标准核对（§11）

- **M4**：v2→v3 迁移与读兼容测试通过 ✔；12 语言样本判定 100%（≥90%）✔；
  续译在模拟 SW 终止后恢复断言通过 ✔；2.0 全部 83 单元 + 61 冒烟保持通过 ✔；
- **M5**：fixture PDF（多页、含页眉页脚、含扫描页占位）冒烟断言通过 ✔；
  聚类单元测试（行距换段、连字符合并、页码过滤）通过 ✔；
  重复打开同文档二次翻译零 API 调用（缓存命中断言）✔；
- **M6**：mock vision 端点请求构造/解析单元测试通过 ✔；fixture 图片冒烟
  （入口出现 → 面板结果 → 复制载荷）通过 ✔；fixture 视频双 cue 冒烟
  （接管 → 双语渲染 → 关闭还原）通过 ✔；不支持视觉的 Provider 入口置灰断言通过 ✔。

## 7. 手动联调清单（§12.3）

| 项 | 状态 | 说明 |
|---|---|---|
| 真实 LLM 视觉 API 翻译截图/图表/多语言混排图片 | 待手动 | 本机 Ollama 无视觉模型（qwen2.5-vl 等未安装）；自动侧已用 mock vision 端点钉住请求/报文与解析路径，接入任一多模态端点即可复验 |
| 真实网站 `<track>` 字幕 + 1 个 subtitleSelectors 站点（YouTube） | 待手动 | 自动侧覆盖 `<track>` 接管/还原与选择器就地翻译机制（内置 `builtin-youtube` 规则随版本更新，站点改版即失效为已知限制） |
| 大 PDF（≥50 页）按页翻译费用与时延记录 | 待手动 | 机制已验证：按页惰性 + 并发 ≤3 + 2000 段预算降级视口±1（单元+冒烟覆盖小文档全流程） |
| 2.0 老设置文件升级 3.0 后全部功能正常 | ✅ 自动覆盖 | 冒烟全部设置写入经真实 save-settings（v2 载荷 → v3 迁移）；`migration3.test.ts` 逐字段保留 + v3→v2 读兼容 |

## 8. 遗留与备注

1. tesseract-wasm 引擎按 P1 保留接口与设置项（`OcrEngine` 抽象 + 设置枚举），
   WASM 分包与两步法实现顺延 3.1（spec §6.1 item 2 / §11 M6「视进度纳入」）；
2. 字幕样式（位置/字号/背景）已实现 `fontSizePct` 设置与双档位；上下位置互换
   与背景自定义顺延后续（spec §7.1 item 4 P1 备注）；
3. PDF 扫描页转视觉管线联动（支柱 E×F）为 P1 备注项，本轮实现 P0 明确提示；
4. webNavigation 自动打开 PDF 已实现为 optional_permissions 流程（Options 开关
   触发授权请求，未授权时静默不生效）；
5. 续译覆盖内容脚本翻译任务；PDF 阅读器页（扩展页）自身保留状态并支持失败重试，
   SW 重启后由阅读器错误重试路径兜底；
6. P2 项（商店上架素材、网关 translate.image、OCR 语言包下载、句子级 TM、
   双栏聚类专项优化）按 spec §3 P2 不在本轮范围。