# 四条翻译流程的验证记录

本次以 2026 年 11 月 22 日的本地工作树为基线，起始提交为 `371ede6`。浏览器实测使用 Windows 上独立配置的 Edge 158.0.4370.33。PolyPage 的浏览器回归使用本机固定 HTTP 翻译服务，检验数据传输、错误处理、页面显示和下载文件。译文质量单独使用真实 OpenCode Go 接口对照。

## 操作次数与等待

次数从用户已经打开目标网页、已配置服务开始。每次点击扩展图标也计一步，选文件计一步。快捷键组合或三连空格算一次触发动作。

| 任务 | 沉浸式翻译公开文档里的路径 | 此次 PolyPage 实测及恢复方式 |
| --- | --- | --- |
| 阅读技术文档 | 页侧图标或快捷键一次，扩展菜单两次。快捷键可切回原文。 | 弹窗 → 翻译此页，两次。两个章节分开翻译。改译名后恢复原文再翻译，失败段可单独重试。 |
| 把中文回复写成英语 | 三连空格或已配置的快捷键，一次触发。文档也列出局部翻译和目标语言前缀。 | 聚焦后，预览 → 替换，两次。可检查引用、代码和译文。继续打字会使旧预览失效，服务报错可从保留的草稿重试。 |
| 阅读本地长 PDF | 扩展 → 更多 → 本地 PDF → 选择文件，四步。文档另列免费标准 PDF、扫描处理和保留排版服务。 | 扩展 → 阅读本地 PDF → 打开本地 PDF → 选择文件，四步。输入页码即可跳转，翻译失败可以重试，导出即使有未读页也能打开。 |
| 读字幕、识别图片 | YouTube 通过扩展面板开启双语字幕，两步，设置未生效时文档建议刷新。图片可用右键菜单两步，已启用悬停时为一次点击。 | 标准轨用扩展 → 字幕翻译，两步。已启用自绘字幕规则的站点可直接显示译文。导出已有字幕或关闭还原均可在弹窗完成。图片悬停后一次点击，动手前显示识别地点和文本服务。在原面板即可重试、复制或关闭。 |

竞品公开材料给出操作路径。输入、字幕及图片等候时间没有同机同服务的对照数据。付费识别和保留排版服务的表现也未计入本次自测。[Edge 商店条目](https://microsoftedge.microsoft.com/addons/detail/amkbmndfnliijdhojkpoglbnaaahippg) · [使用文档](https://immersivetranslate.com/zh-Hans/docs/usage/) · [输入框文档](https://immersivetranslate.com/zh-Hans/docs/input/)

**商店版网页实测**。从微软官方更新服务取得该条目发布的沉浸式翻译 1.35.4，在一次性 Edge 配置加载，未登录且未配置密钥。自制网页有标题 “Network sockets” 和正文 “The port is closed. Restart the service before deploying.”。一次成功运行中，从点击页侧悬浮球到正文下首次可读中文为 **8412 ms**，结果为「港口关闭了。在部署之前重启服务。」。同一页再点悬浮球，译文消失，原句仍在。另一个全新配置点击后约 18 秒仍只有原文，出现「降级使用机器翻译」「立即登录」两个入口。两个结果受默认服务和网络影响。此测量使用竞品在线服务，PolyPage 的确定性本地端点用时只有交互参考意义。[Edge 商店条目](https://microsoftedge.microsoft.com/addons/detail/amkbmndfnliijdhojkpoglbnaaahippg) · [微软官方扩展更新地址说明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-faq)

**免费 PDF 网页实测**。同一台 Edge 158 使用两个独立的新浏览上下文，均未登录、未安装竞品扩展。官方免费入口点「pdf 文件」，等阅读器自带示例加载完，点「打开新文件」并选择与 PolyPage 测量相同的自制 180 页 `reading.pdf`（724,428 字节）。从文件选择的 change 事件到第一页原文画布出现字迹、文本层同时能读到试验正文，两次分别为 **262 ms、231 ms**。计时从已打开的阅读器开始。右侧对照栏仍为英文，页面提示安装或启用沉浸式翻译扩展并刷新。在提示条点「重试」后原文件仍在，约 4 秒后安装提示仍可见。此次无扩展条件下未取得首条译文耗时。[官方免费文件入口](https://app.immersivetranslate.com/file/) · [公开 PDF 阅读器](https://app.immersivetranslate.com/pdf/) · [官方恢复说明](https://immersivetranslate.com/zh-Hans/docs/pdf-helper/)

**同一起点的 PolyPage 本地结果**。在同机 Edge 158.0.4370.33、1280 × 900 视口、两份独立的新配置中打开已构建的阅读器，点击「打开本地 PDF」并选择同一文件（SHA-256 前 16 位为 `03e50d1df63f5725`）。两边都从文件选择的 `change` 事件起按动画帧采样画布和可读原文。PolyPage 首次画布见字为 **188 ms、167 ms**，邻栏出现可读原文段落也是 **188 ms、167 ms**，两轮的两个条件均出现在同一帧。本机固定服务返回的第一页首条译文分别在 **348 ms、339 ms** 出现（从同一事件计时，HTTP 服务附加 60 ms 延迟）。这两次原文测量仅代表此次本地选文件场景。

**加载商店扩展后的免费 PDF 翻译**。另取独立 Edge 配置，加载上述 1.35.4，未登录、不填密钥，同一公开阅读器显示「免费翻译服务」。打开同一文件，停留在第一页就自动出现中文。按相同文件选择起点，第一轮原文可读为 717 ms，第一条中文「系统手册 / 读本」为 4759 ms。该条是页眉。第二轮专门计时到实际正文，原文可读为 **530 ms**，页眉中文为 **2700 ms**，第一段中文在 **3134 ms** 出现在视口内，开头为「第 1 页，第 1 行。该服务将每条记录存储在持久队列中。」。两轮都只执行选文件，未启动「翻译全部并下载」。这是竞品的在线服务，后端不同于上述 PolyPage 本机固定服务。[官方免费 PDF 阅读器](https://app.immersivetranslate.com/pdf/)

## 上下文和术语

真实模型从同一句话在两个章节都给出「端口已关闭」，改为在港务章给出「港口已关闭」。真实请求样例、各服务字段、改名后的译文、输入 token、每个请求的耗时、浏览器三次对照和单独复测命令见[上下文对照](context-reading.md)。

## 输入框

原版在多行中文草稿中没有预览或写回入口。新版使用同一翻译管线，独立设置写作目标语言。为保留代码、引用和富文本标记，整份草稿可以拆成多个可编辑的文本片段。预览对应用户选区或整份草稿，替换前核对目标快照。

- 匿名 Edge 能打开真实 GitHub issue。站点要求登录才能评论，实际写入在相同浏览器中的本地 issue 页面、React 18.3.1 受控 textarea 验证。[GitHub 页面](https://github.com/microsoft/TypeScript/issues/1)
- 英文 issue 显示中文后，用户输入中文回复。实际扩展的两次「点击到预览出现」为 34 和 46 ms，文本由本机固定服务提供。React 收到替换和撤销事件。普通 input 的反向选区与撤销后光标正确，富文本中的加粗、引用和代码保留。通过 Chromium 的 IME 接口发送组字并提交「中」。没有测试物理中文输入法候选窗。
- 请求延迟 350 ms 时继续输入，旧译文不会覆盖新增文字。HTTP 400、客户端超时后，框内保留原稿并可重试。密码框没有入口。
- 真实 OpenCode Go 返回 `deepseek-v4.1-flash`，单次 3741 ms、156 输入 token。「我可以复现这个问题。升级后，测试仍然失败。」得到 “I can reproduce this issue. After the upgrade, the test still fails.”

## 本地长 PDF

初始阅读器会先提取全书文字并创建所有页面，才能显示第一页。使用同一份 180 页文件、同一台 Edge 和固定延迟 60 ms 的文本服务，各做三轮冷开和暖开。取中位数，冷开第一页原文从 400 ms 降至 271 ms，首段译文从 557 ms 降至 433 ms。暖开分别从 352 ms 降至 207 ms、422 ms 降至 285 ms。首屏可读时实际创建的页节点从 180 个降至 1 个。这里从同一阅读器地址开始导航，与上面的本地文件选择计时分别记录。

从扩展弹窗打开本地文件后，输入页码可跳到未读页，在译段和纸面原文之间来回定位。当前页和全文都可导出双语 HTML，未读页和缺译处会在文件里标明。本次在 Edge 中重新打开了下载的 HTML，并抽查了 BERT 摘要、ResNet 的双栏和表格，使用本地 OCR 读出了扫描页。三轮原始耗时、逐页结果和复杂表格的剩余问题见[长 PDF 阅读与双语导出](pdf-reading.md)。

## 字幕和图片

后续已在 YouTube 官方播放器的公开嵌入视频上完成手选英语、切换西语、跳播、全屏、实际下载 SRT 及关闭还原，并修复了隐私增强播放器识别、弹窗路由和语言提示混入字幕的问题。[YouTube 实站字幕验证](youtube-subtitles.md)

旧版同时把英法字幕交给调度器，同一时刻发出 `Hello Bonjour`。自绘字幕会覆盖播放器原来的节点文字。图片 OCR 未结束时关闭面板，迟到的结果会再次弹出面板。这两项基线分别由轨道和迟到结果的回归用例复现。

- 标准字幕在真实 Edge 中完成英法切换、1.2 → 4.2 秒跳播、容器全屏、原生 video 全屏、导出和关闭还原。浏览器测试一次从跳到激活字幕位置至译文可读为 82 ms，使用 80 ms 轮询及本地固定服务。下载的文件按字节解码为含 BOM 的 UTF-8，时间为 `00:00:01,000 --> 00:00:03,000` 和 `00:00:04,000 --> 00:00:07,000`，断言比对了完整文件，包括原文换行、中文、序号和 CRLF。
- 自绘字幕用真实播放器和与 YouTube 站点规则一致的 DOM 夹具。复用原节点、修改字幕语言、跳播、容器全屏和关闭后都保留了播放器自己的文字与标记。SRT 时间来自观看期间采样的播放器时钟，采样间隔 150 ms，覆盖已观看并取得译文的字幕。
- YouTube 实站使用独立 Edge 158 配置，翻译服务指向本机 HTTP 替身。官方示例视频出现地区限播提示。TED 视频点击「跳过」后，第 22 秒开始播放 14 分 04 秒的正片，播放进度达到 31 秒时字幕按钮仍显示「无法显示字幕」。第 76 秒播放器提示「出了点问题。请刷新或稍后重试。」[官方示例视频](https://www.youtube.com/watch?v=EWX0bbGAd0k) · [TED 视频](https://www.youtube.com/watch?v=arj7oStGLkU)
- 在 3Blue1Brown 视频中，进入正片后打开播放器「设置 → 字幕」，从「中文（中国）」切到「英语」。刷新后菜单仍显示「英语」。两次播放均在约一分钟内出现相同的播放器错误。两条正片都没有观察到标准字幕轨或 `.ytp-caption-segment`，本机翻译请求均为 0。线上开关、关闭后原文恢复及切换语言时最近的 `[lang]` 均未能核验。现有开关、全屏和恢复结果来自上面的 Edge 夹具。[3Blue1Brown 视频](https://www.youtube.com/watch?v=aircAruvnKk)
- 图片在浏览器内实际运行本地 Tesseract WASM。本次两张图分别是仓库内清晰的 `HELLO WORLD` 和现场生成的 6 px 低对比度倾斜文字 `Minimum 5`。清晰图识别为 `HELLO WORLD`，由本机固定服务返回「你好，世界」。一次从悬停、点击到冷 OCR 结果为 435 ms。故意让文本服务失败后，原面板重试到译文为 137 ms（WASM 已加载，结果缓存关闭）。实读剪贴板包含原文和译文，收起后面板和图片覆盖层均移除。难图显示「未识别到文字」并提供重试。
- 真实模型另测了一次同一张清晰图片。从点击到回环服务收到 Tesseract 识别的 `HELLO WORLD` 为 361 ms。回环服务用仓库已有的 OpenCode Go 适配器发出一笔文本翻译，`deepseek-v4.1-flash` 返回 HTTP 200 和「你好，世界」，耗时 3514 ms，150 个输入 token。浏览器面板同时出现两行文字，距点击 3915 ms。密钥只在桥接进程内读取，浏览器只配置回环地址。
- 无字幕转写由用户主动触发，默认从当前播放位置采集最多 90 秒。所配本地网关没有 Whisper 后端。Go 目录所列音频输入模型使用聊天或其他生成接口，没有声明现有适配器需要的音频转写端点。真实 ASR 的识别准确率及首条耗时尚无数据，完整 smoke 对无字幕路径使用模拟转写响应。

## 本机复测

统一构建生成了 Edge/Chrome 和 Firefox 两套扩展。TypeScript 检查通过，Vitest 共 91 个文件、571 项通过，.NET 网关 61 项通过，stdio 契约 11 项通过。Edge 总冒烟 143 项通过，包括实际重启后台后恢复 PDF 译段。下面四个专项浏览器脚本也在同一份最终构建上通过。

```powershell
npm run typecheck
npm test
npm run build
npm run test:gateway
npm run test:contract
node scripts/context-reading-check.mjs
node scripts/draft-browser-check.mjs
node scripts/media-browser-check.mjs
python scripts/fixtures/make-reader-sample.py "$env:TEMP/polypage-reading-sample.pdf"
node scripts/pdf-reader-check.mjs "$env:TEMP/polypage-reading-sample.pdf"
npm run smoke
```

浏览器脚本默认使用本机 Edge，可通过 `EDGE_PATH` 指定。媒体测试用 `ffmpeg` 生成可跳播的短片。PDF 夹具生成器用 ReportLab 和 Pillow。输入框脚本默认覆盖 DOM 事件；将 `DRAFT_REACT_MODULES` 设为含 React 18 和 React DOM 的本地 node_modules 可重复受控组件测试。真实模型复测另行运行 `node scripts/context-live-check.mjs`，该命令使用账号额度。
