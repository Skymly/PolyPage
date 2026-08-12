# 项目目标文档：网页翻译浏览器插件 1.0

## 0. 给 Agent 的总指令

请基于本文档执行项目开发。当前版本为 **1.0 MVP**，目标方案是：

> **浏览器插件（TypeScript）+ 自定义 API / LLM**
>
> 暂不实现本地 Native Host、C#/.NET 服务或桌面程序。
>
> 但架构设计需要为后续接入本地 Host / C#/.NET 网关预留扩展点。

请严格遵循以下原则：

1. 优先支持 Chrome 和 Edge。
2. 使用 Manifest V3。
3. 插件主体使用 TypeScript 实现。
4. 不引入远程代码执行机制。
5. 不使用 C#/.NET 作为 1.0 插件主体。
6. 保持翻译服务 Provider 抽象，便于后续接入本地 Host。
7. 优先保证页面稳定性，避免翻译破坏原网页 DOM。
8. 优先实现段落级翻译、显示模式切换、Tooltip、沉浸式双语翻译。
9. 1.0 不追求支持所有网站，先保证普通文章类网页可用。
10. 每个阶段都应产出可加载、可运行、可验证的浏览器扩展版本。

---

## 1. 项目名称

Web Translator Extension

可简称为：

> Web Translator 1.0

---

## 2. 项目愿景

构建一个适用于 Chrome / Edge 的网页翻译浏览器插件，帮助用户在阅读外文网页时获得以下能力：

1. 查看原文；
2. 查看译文；
3. 在译文模式下悬停查看原文；
4. 在原文模式下悬停查看译文；
5. 沉浸式双语阅读；
6. 接入自定义翻译 API 或 LLM；
7. 支持用户配置 API Key、Base URL、Model、Prompt 等参数。

---

## 3. 1.0 版本目标

1.0 版本要实现一个可实际使用的浏览器翻译插件 MVP。

核心目标包括：

1. 支持 Chrome / Edge 浏览器扩展加载；
2. 支持 Manifest V3；
3. 支持手动触发当前网页翻译；
4. 支持显示原文；
5. 支持显示译文；
6. 支持译文模式下鼠标悬停显示原文气泡；
7. 支持原文模式下鼠标悬停显示译文气泡；
8. 支持沉浸式双语对照翻译；
9. 支持配置自定义翻译 API；
10. 支持 OpenAI-compatible 类型 LLM API；
11. 支持基础翻译缓存；
12. 支持基础错误提示；
13. 支持设置页面；
14. 支持 Popup 快捷操作；
15. 架构上为后续本地 Host 预留扩展能力。

---

## 4. 1.0 非目标

以下内容 1.0 版本不实现，或仅做少量预留：

1. 不实现 C#/.NET 插件主体；
2. 不实现 Native Messaging Host；
3. 不实现本地桌面程序；
4. 不实现本地模型运行环境；
5. 不实现账号系统；
6. 不实现云端配置同步；
7. 不实现多用户配额系统；
8. 不实现复杂的可视化网站规则编辑器；
9. 不实现划词翻译作为核心功能，可作为后续增强；
10. 不实现 PDF 翻译；
11. 不实现图片 OCR 翻译；
12. 不实现视频字幕翻译；
13. 不保证支持所有网站；
14. 不处理 Chrome Web Store 上架所需全部隐私合规材料，但需遵守基本 MV3 规范；
15. 不实现自动更新服务端；
16. 不实现复杂的企业级审计日志。

---

## 5. 目标用户

1. 需要阅读外文网页的普通用户；
2. 希望自定义翻译 API 的开发者；
3. 希望使用自己的 LLM API Key 的用户；
4. 希望进行双语对照阅读的用户；
5. 对翻译质量有较高要求，并愿意配置 Prompt 或模型的用户。

---

## 6. 核心价值

1. 比浏览器自带翻译更灵活；
2. 支持 LLM 翻译；
3. 支持自定义 API；
4. 支持原文 / 译文多种显示模式；
5. 支持沉浸式双语阅读；
6. 对用户配置开放；
7. 架构可扩展到本地 Host 或企业翻译网关。

---

## 7. 1.0 功能范围

## 7.1 显示模式

插件需要支持以下显示模式：

| 模式 ID | 模式名称 | 页面主体显示 | 鼠标悬停显示 | 说明 |
|---|---|---|---|---|
| original | 原文模式 | 原文 | 无 | 恢复或保持原文 |
| translated | 译文模式 | 译文 | 无 | 将段落替换为译文 |
| translated_hover_original | 译文 + 原文气泡 | 译文 | 原文 | 主体显示译文，悬停查看原文 |
| original_hover_translated | 原文 + 译文气泡 | 原文 | 译文 | 主体显示原文，悬停查看译文 |
| bilingual | 沉浸式双语 | 原文 + 译文 | 无 | 段落级双语对照 |

要求：

1. 用户可以在 Popup 中快速切换模式；
2. 用户可以在设置页中配置默认模式；
3. 模式切换应尽量不重新请求已缓存翻译；
4. 模式切换应避免页面大幅重排；
5. 原文必须可恢复；
6. 翻译状态应可被重置。

---

## 7.2 翻译触发方式

1.0 版本支持以下触发方式：

1. Popup 中点击“翻译当前页”；
2. Popup 中点击“恢复原文”；
3. Popup 中切换显示模式；
4. 设置页中配置默认自动翻译，可选；
5. 可选快捷键，不作为强制需求。

暂不要求：

1. 复杂右键菜单；
2. 划词翻译；
3. 输入框翻译；
4. 选区浮窗翻译。

---

## 7.3 网页内容识别

1.0 版本需要支持常见网页正文内容识别。

默认可翻译元素包括：

1. `p`
2. `h1`
3. `h2`
4. `h3`
5. `h4`
6. `h5`
7. `h6`
8. `li`
9. `blockquote`
10. `figcaption`
11. `td`
12. `th`
13. `article`
14. `section`
15. 含有较长文本的 `div`

默认跳过元素包括：

1. `script`
2. `style`
3. `noscript`
4. `code`
5. `pre`
6. `textarea`
7. `input`
8. `select`
9. `button`
10. `svg`
11. `canvas`
12. `iframe`
13. `img`
14. `video`
15. `audio`

对于按钮、导航、菜单等短文本，1.0 默认不主动翻译，避免破坏交互。

需要支持基础过滤规则：

1. 文本长度过短不翻译；
2. 纯数字不翻译；
3. 纯 URL 不翻译；
4. 纯邮箱不翻译；
5. 代码片段不翻译；
6. 已翻译节点不重复翻译；
7. 不可见节点可延后翻译；
8. 隐藏节点不翻译。

---

## 7.4 Tooltip 气泡

需要支持两种 Tooltip 场景：

### 场景 A：译文模式下悬停显示原文

当页面主体显示译文时，鼠标悬停到段落上，显示对应原文。

### 场景 B：原文模式下悬停显示译文

当页面主体显示原文时，鼠标悬停到段落上，显示对应译文。

Tooltip 要求：

1. 使用轻量气泡组件；
2. 不影响原页面样式；
3. 建议使用 Shadow DOM 隔离样式；
4. 支持长文本换行；
5. 支持最大宽度限制；
6. 支持最大高度和滚动；
7. 鼠标移出后延迟关闭；
8. 避免频繁闪烁；
9. 避免遮挡鼠标；
10. 在页面滚动时正确关闭或重新定位；
11. 如果译文尚未生成，可显示“翻译中”状态；
12. 如果翻译失败，可显示失败提示；
13. 不应将 Tooltip 内容插入到原页面正文 DOM 中。

---

## 7.5 沉浸式翻译

沉浸式翻译指在网页段落附近同时展示原文和译文。

1.0 版本默认采用：

> 原文下方插入译文块。

要求：

1. 保留原文；
2. 在原文段落附近插入译文；
3. 译文块应有明显但不过度干扰的样式；
4. 不破坏原段落链接、强调、列表结构；
5. 不修改原页面脚本依赖的关键 DOM 属性；
6. 支持翻译中状态；
7. 支持翻译失败状态；
8. 支持删除已插入的译文块；
9. 支持恢复原文模式；
10. 对动态新增内容可选手动重新扫描。

1.0 不强制支持：

1. 段内 inline 对照；
2. 左右分栏对照；
3. 所有网站自动完美适配；
4. Shadow DOM 深度穿透；
5. iframe 内翻译；
6. 虚拟列表完整适配。

---

## 7.6 自定义翻译 API / LLM

1.0 需要支持用户配置翻译服务。

需要支持的服务类型：

1. OpenAI-compatible LLM API；
2. 通用自定义 HTTP JSON API。

后续可扩展：

1. DeepL；
2. Azure Translator；
3. Google Translate；
4. Ollama；
5. 本地 Host；
6. 企业内网网关。

1.0 必须设计统一的 Provider 抽象层。

---

## 8. Provider 抽象要求

翻译服务必须通过统一接口调用，不允许将具体 API 逻辑硬编码到 UI 或 Content Script 中。

Provider 需要具备以下能力：

1. 根据配置发起翻译请求；
2. 支持单条文本翻译；
3. 支持批量文本翻译；
4. 支持超时控制；
5. 支持错误分类；
6. 支持请求取消；
7. 支持基本重试；
8. 支持语言参数；
9. 支持自定义 Prompt；
10. 支持返回结构化翻译结果；
11. 支持后续替换为本地 Host Provider。

---

## 8.1 Provider 配置字段

Provider 配置至少包含以下字段：

| 字段 | 说明 |
|---|---|
| id | Provider 唯一 ID |
| name | Provider 名称 |
| type | Provider 类型 |
| baseUrl | API Base URL |
| apiKey | API Key |
| model | 模型名称 |
| sourceLanguage | 源语言 |
| targetLanguage | 目标语言 |
| timeoutMs | 请求超时时间 |
| maxBatchItems | 批量翻译最大条目数 |
| maxBatchChars | 批量翻译最大字符数 |
| systemPrompt | System Prompt |
| userPromptTemplate | User Prompt 模板 |
| temperature | LLM temperature |
| maxTokens | LLM max tokens |
| headers | 自定义请求头 |
| enabled | 是否启用 |

---

## 8.2 Provider 类型

1.0 至少支持：

### openai-compatible

适用于：

1. OpenAI；
2. Azure OpenAI 兼容模式；
3. DeepSeek；
4. Moonshot；
5. Ollama OpenAI 兼容接口；
6. OpenRouter；
7. 其他 OpenAI-compatible API。

请求目标通常是：

> `POST {baseUrl}/chat/completions`

需要支持：

1. system message；
2. user message；
3. model；
4. temperature；
5. max_tokens；
6. Authorization Bearer Token。

翻译输出建议要求模型只返回译文，不返回解释。

批量翻译时建议要求模型按 JSON 数组或编号列表返回。

### custom-http

适用于用户自定义翻译 API。

需要支持：

1. 自定义 URL；
2. 自定义 Method，1.0 可默认 POST；
3. 自定义 Headers；
4. 自定义 Body 模板；
5. 自定义响应字段路径；
6. API Key 可放入 Header、Query 或 Body。

1.0 可以先实现简化版：

1. 用户配置请求模板；
2. 用户配置响应字段路径；
3. 插件解析 JSON 响应；
4. 若解析失败则显示错误。

---

## 8.3 LLM Prompt 要求

LLM 翻译 Prompt 应满足：

1. 明确要求只输出译文；
2. 不输出解释；
3. 不输出原文；
4. 不改变链接；
5. 不翻译代码；
6. 不翻译 URL；
7. 不翻译邮箱；
8. 不翻译占位符；
9. 保持段落顺序；
10. 保持标点风格；
11. 批量翻译时要求结构化返回；
12. 可指定源语言和目标语言；
13. 可附加术语表；
14. 可附加领域说明。

Prompt 模板中可使用的变量建议包括：

| 变量 | 说明 |
|---|---|
| sourceLanguage | 源语言 |
| targetLanguage | 目标语言 |
| text | 单条待翻译文本 |
| texts | 批量待翻译文本 |
| domain | 当前网页域名 |
| glossary | 术语表 |

1.0 至少支持 `sourceLanguage`、`targetLanguage`、`text` 或 `texts`。

---

## 9. 翻译流程

整体流程如下：

1. 用户点击翻译；
2. Content Script 扫描当前页面；
3. 识别可翻译段落；
4. 过滤不需要翻译的内容；
5. 为每个段落生成翻译任务；
6. 将任务发送到 Background Service Worker；
7. Background 根据 Provider 配置进行批量合并；
8. 调用翻译 API 或 LLM；
9. 返回翻译结果；
10. Content Script 根据当前显示模式渲染；
11. 结果写入缓存；
12. 错误任务进入失败状态；
13. 用户可重试失败任务；
14. 用户可恢复原文。

---

## 10. 架构设计

1.0 推荐采用以下模块结构：

1. Manifest；
2. Background Service Worker；
3. Content Script；
4. Popup UI；
5. Options UI；
6. Provider 层；
7. Storage 层；
8. Cache 层；
9. DOM 渲染层；
10. Tooltip 组件；
11. 消息通信层；
12. 共享类型与工具。

---

## 10.1 Background Service Worker 职责

Background 负责：

1. 读取 Provider 配置；
2. 管理翻译请求队列；
3. 批量合并请求；
4. 调用 Provider；
5. 处理超时；
6. 处理重试；
7. 写入翻译缓存；
8. 向 Content Script 返回结果；
9. 处理错误分类；
10. 不直接操作页面 DOM。

---

## 10.2 Content Script 职责

Content Script 负责：

1. 扫描页面；
2. 识别可翻译节点；
3. 提取文本；
4. 维护原文与译文映射；
5. 渲染翻译结果；
6. 显示 Tooltip；
7. 插入双语对照块；
8. 监听动态 DOM；
9. 处理模式切换；
10. 不保存 API Key；
11. 不直接调用外部翻译 API。

---

## 10.3 Popup 职责

Popup 负责：

1. 开关当前页翻译；
2. 切换显示模式；
3. 显示当前页翻译状态；
4. 显示当前 Provider；
5. 显示目标语言；
6. 快速打开设置页；
7. 显示错误摘要。

---

## 10.4 Options 设置页职责

Options 负责：

1. Provider 管理；
2. API Key 配置；
3. Base URL 配置；
4. Model 配置；
5. Prompt 配置；
6. 默认语言配置；
7. 默认显示模式配置；
8. 缓存管理；
9. 敏感网站黑名单；
10. 翻译快捷键说明；
11. 错误日志查看；
12. 导入导出配置。

---

## 11. 推荐目录结构

项目目录建议如下：

```text
web-translator/
├── public/
│   ├── icons/
│   └── manifest.json
├── src/
│   ├── background/
│   │   └── service-worker.ts
│   ├── content/
│   │   ├── scanner.ts
│   │   ├── translator.ts
│   │   ├── renderer.ts
│   │   ├── tooltip.ts
│   │   ├── observer.ts
│   │   └── index.ts
│   ├── popup/
│   │   ├── main.ts
│   │   └── popup.html
│   ├── options/
│   │   ├── main.ts
│   │   └── options.html
│   ├── providers/
│   │   ├── provider.ts
│   │   ├── openai-compatible.ts
│   │   └── custom-http.ts
│   ├── storage/
│   │   ├── settings.ts
│   │   └── cache.ts
│   ├── messaging/
│   │   └── messages.ts
│   ├── shared/
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   └── utils.ts
│   └── styles/
│       ├── content.css
│       └── tooltip.css
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md