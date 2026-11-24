# 技术文档的语境、术语和重译

2026 年 11 月 22 日，在 Windows 上使用工作区已有的 OpenCode Go 适配器、Edge 158.0.4370.33 与两个自制章节做了对照。原句 `The port is closed.` 位于网络章时应译为「端口已关闭」，位于港务章时应译为「港口已关闭」。

## 真实服务

项目从 `ProviderConfig.apiKey` 取密钥。验证进程从本机环境变量 `OpenCodeGo` 读取后直接交给适配器。官方 Go 目录返回 31 个模型，最接近需求所写名称的是 `deepseek-v4.1-flash`，目录声明支持文本输入与输出。用一笔独立的 `Hello.` 请求确认本账号可调用，HTTP 200、响应模型同名、输出「你好。」、148 个输入 token，耗时 2429 ms。[Go 模型目录](https://opencode.ai/inference/go/v1/models)

前后都设置 English → 简体中文、temperature 0、推理强度 low，使用项目默认提示词。两边逐例直接调用相同 Go 适配器，绕过本地缓存与句子翻译记忆，以便看到模型对每组输入的实际回答。旧版使用当时工作区的原始请求构造，新版使用有界上下文。每例各取一次，计时从发出 HTTP 请求到读取完整响应。

| 场景和原句 | 原版译文 | 新版译文 | 消息字符数，前 → 后 | 输入 token，前 → 后 | 往返 ms，前 → 后 |
| --- | --- | --- | ---: | ---: | ---: |
| 网络章 · The port is closed. | 端口已关闭。 | 端口已关闭。 | 737 → 702 | 210 → 174 | 5580 → 4098 |
| 港务章 · The port is closed. | 端口已关闭。 | 港口已关闭。 | 737 → 690 | 210 → 175 | 4356 → 3030 |
| 两段同批 · Start Atlas before deploying. / Atlas handles the new deployment. | 部署前启动星图引擎。／星图引擎处理新部署。 | 部署前启动星图引擎。／星图引擎处理新部署。 | 896 → 893 | 245 → 222 | 2811 → 2185 |
| 修改译名 · Start Atlas before deploying. | 部署前启动星图系统。 | 部署前启动星图系统。 | 747 → 744 | 210 → 187 | 2279 → 3917 |

四例前后均为四次请求，服务端合计输入从 875 减为 758 个 token。消息正文的 JavaScript 字符长度合计从 3117 减为 3029。标题分别为 `Operations manual` 和 `Product guide`。网络章使用 `TCP sockets and inbound connections`，港务章使用 `Harbors and cargo ships`，产品章使用 `Atlas deployments`。两次同词测试包含同一份九条术语表，只有产品章的正文命中 Atlas。其余八条为 container、pipeline、memory、heap、kernel、frame、gateway、replica。

港务章修正了一处影响理解的词义。原版已能处理默认提示词中的用户译名，新版保住了跨段一致性和修改后的译名。九条术语表的过滤抵消了添加标题和章节的输入成本。更短的术语表、分章更密的文档会有不同成本，下面的整页测量就是例子。

## 浏览器里的整页成本与恢复

在同一台机器交替运行修改前保存的扩展产物与新产物，各三次，每次使用新建的独立 Edge 配置。网页包含两个标题和四个正文段，设置页配置 Atlas 与一个未命中术语。测试通过真正的扩展设置页保存术语，通过弹窗的「翻译此页」「恢复原文」按钮操作，读取最终 DOM。HTTP 端点是本地确定性模型，它从收到的章节和术语返回译文。这部分验证传参、批次、更新和显示。

| 同一 HTML、相同本地模型 | 修改前 | 修改后 |
| --- | --- | --- |
| 首次点击的 HTTP 请求数 | 1 | 2 |
| 保存新译名、恢复原文、再次点击的 HTTP 请求数 | 1 | 2 |
| 两次翻译合计的消息字符数 | 1762 | 3452 |
| 首次点击到四段译文齐全，三次实测 ms | 746、1165、1216 | 890、526、167 |
| 更改术语后的点击到四段齐全，三次实测 ms | 171、258、981 | 240、167、167 |
| 港务段 / 网络段 | 端口 / 端口 | 港口 / 端口 |
| Atlas 两段改名 | 两段均更新 | 两段均更新 |

新版本用额外一次请求拆分章节，使这两处相同原句能分别得到合适的译文。中位等待为首次 1165 → 526 ms、重译 258 → 167 ms。计时采用 75 ms 轮询，同期有其他验证任务，三次结果的波动较大。线上服务的等待时间需结合分批、网络和模型延迟单独衡量。

## 各服务如何使用术语

原先网页仅带站点和部分路径中的页面语言，PDF 指纹和段落坐标只进缓存键。默认聊天提示词包含整个术语表，缓存没有区分章节，句子翻译记忆按规范化语句、语言对、术语版本查找。新增的回归用例在修改前分别启用缓存或翻译记忆时均无法收到章节。

网页批处理、段内模式和流式悬停现在传递标题和同一内容区前面符合站点规则的可见原文章节标题。PDF 优先使用文件元数据标题，缺失时取文件名。PDF 的章节优先取本页最近的大字号短段，要求不超过 120 个字符、字号至少为本页中位字号的 1.2 倍。段首缺少标题时检查内部书签（最多 256 条），再查紧邻前一页的标题。缺少可靠标签时省略该字段，跳页时无需先处理前面的所有页。

两个标签分别限制为 96 个 Unicode 字符，每批按顺序选择原文命中的完整术语，最多 12 条，格式化后上限 1024 个 UTF-16 单元。英文按大小写不敏感的完整词匹配，中文可在无空格的句子中命中。缓存和句子翻译记忆的上下文标识区分站点、文档与章节标签、服务配置和术语表内容。已有语境缺失的记录无法命中带标签的新请求，PDF 指纹仍只进缓存键。

如果合批会挤掉另一段本应命中的术语，管线会拆成两个请求。没有已识别原文的视觉一步翻译与语音转写都不附带任意术语，图片本地 OCR 后的文本翻译会匹配术语。句子翻译记忆区分 C、C# 和 C++。旧版把它们归一为相同文字，无法追溯原词，因此新版首次查询会重新建立记忆条目。

| 用户的文本服务 | 请求中实际发送的内容 |
| --- | --- |
| OpenAI 兼容接口、OpenCode Go | 标题、章节放入用户消息作为词义参考。命中术语按模板传递，自定义提示词省略术语变量时通过用户消息补充。|
| DeepL | 使用翻译 API 的 `context` 字段提供标题、章节和命中术语。该字段是翻译参考，不能保证逐词采用指定译名。[DeepL context 说明](https://developers.deepl.com/docs/learning-how-tos/examples-and-guides/how-to-use-context-parameter) |
| 自定义 HTTP | POST Body 模板可引用 `{{documentTitle}}`、`{{section}}`、`{{glossary}}`。GET 使用既有的原文与语言查询参数。|
| 本机网关 | 新网关接收可选字段。Ollama 使用提示词，HTTP 后端按网关的 Body 模板发送。已经安装旧网关的用户需更新网关才能用到这些字段。|
| Azure Translator、Google Translate | 当前适配器按标准文本翻译接口提交正文和语言，本地术语未应用；设置页明确提示。|

## 复核与试用

1. 在扩展设置选择自己的服务，打开「术语表」，读当前服务说明，粘贴 `Atlas = 星图引擎`、导入并保存。
2. 在包含网络章、港务章的网页点击扩展图标，再点「翻译此页」。网络失败可在同一弹窗点「重试失败」。需要改译名时回到术语表保存，在原网页「恢复原文」后重新翻译。
3. 本地复测执行 `npm run build`，然后运行 `node scripts/context-reading-check.mjs`。保留旧构建的情况下可运行 `node scripts/context-reading-check.mjs "<旧扩展目录>" --baseline`。
4. 单元与集成验证执行 `npx vitest run tests/document-context.test.ts tests/scanner.test.ts tests/viewport-io.test.ts tests/pipeline.test.ts tests/tm.test.ts tests/custom-http.test.ts tests/opencode-go.test.ts tests/providers.test.ts tests/selection-stream.test.ts`。网关用 `dotnet test native-host/PolyPage.slnx -v q`，61 项通过，同时已通过 `npm run typecheck`。
5. 需要重复真实实验时运行 `node scripts/context-live-check.mjs`。脚本先检查文本目录，再发最小请求。它重建旧提示词，运行相同四组固定无敏感原句的前后对照。正常约九个模型请求，服务错误或批量回退可能改变次数。输出含实际模型、状态、输入量、译文和用时。

沉浸式翻译的快速开始列出侧边快捷图标或快捷键一次触发、扩展面板两次点击的网页入口。其高级设置支持用术语库名称表达语境，并提示语境选择依赖模型判断。PolyPage 的主流程仍是弹窗两次点击，已配置术语的网页自动带上可得的章节。竞品文档没有对本例声明延迟，本次也没有竞品同机计时。[Edge 商店条目](https://microsoftedge.microsoft.com/addons/detail/amkbmndfnliijdhojkpoglbnaaahippg) · [使用文档](https://immersivetranslate.com/zh-Hans/docs/usage/) · [高级术语选项](https://immersivetranslate.com/zh-Hans/docs/advanced/)
