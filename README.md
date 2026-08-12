# PolyPage — Web Translator Extension

网页翻译浏览器插件 1.0（Chrome / Edge，Manifest V3，TypeScript）。

接入你自己的 **LLM / 自定义翻译 API**，在任意网页上获得：

- 原文 / 译文 / 双语对照等多种显示模式；
- 译文模式悬停看原文、原文模式悬停看译文（Shadow DOM 气泡）；
- 沉浸式双语阅读（原文下方插入译文块）；
- 翻译缓存、批量合并请求、超时 / 重试、错误分类与日志。

> 本项目按 `PolyPage.md` 规格文档实现，完整需求对照见文末「规格覆盖」。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 显示模式 | `original` / `translated` / `translated_hover_original` / `original_hover_translated` / `bilingual` |
| 触发方式 | Popup 按钮、模式切换、快捷键 `Ctrl+Shift+L`（可改）、可选的打开页面自动翻译 |
| 内容识别 | `p`、`h1–h6`、`li`、`blockquote`、`figcaption`、`td/th`、`article/section/div`（叶子优先），跳过 `script/code/pre/表单控件/媒体/nav` 等 |
| 文本过滤 | 过短、纯数字、纯 URL、纯邮箱、代码片段、隐藏节点不翻译 |
| Tooltip | Shadow DOM 隔离、限宽限高滚动、延迟关闭、滚动自动关闭、翻译中/失败状态 |
| Provider | `openai-compatible`（OpenAI / DeepSeek / Moonshot / OpenRouter / Ollama 等）、`custom-http`（任意 JSON API），可扩展注册 |
| 批量策略 | 后台 80ms 窗口合并请求，受 `maxBatchItems` / `maxBatchChars` 限制，并发 2，失败自动分类 |
| 缓存 | `chrome.storage.local`，键为 Provider+语言+文本，LRU 上限 3000 条，可在设置页清空 |
| 安全 | API Key 只存于后台，Content Script 不接触密钥、不直接调外部 API；无远程代码执行 |

## 目录结构

```text
├── public/
│   ├── icons/                  # 构建脚本生成的图标
│   └── manifest.json           # MV3 清单
├── src/
│   ├── background/service-worker.ts   # 队列/批量/缓存/错误分类
│   ├── content/                # scanner/translator/renderer/tooltip/observer
│   ├── popup/                  # 快捷操作 UI
│   ├── options/                # Provider 与全局设置 UI
│   ├── providers/              # provider.ts 抽象 + openai-compatible + custom-http
│   ├── storage/                # settings.ts + cache.ts
│   ├── messaging/messages.ts   # 类型化消息协议
│   ├── shared/                 # types/constants/utils/textFilters
│   └── styles/                 # content.css + tooltip.css(注入 Shadow DOM)
├── scripts/
│   ├── build.mjs               # 4 段 vite 构建 + dist 校验
│   ├── generate-icons.mjs      # 零依赖 PNG 图标生成
│   └── smoke-test.mjs          # 无头浏览器端到端冒烟测试
└── tests/                      # vitest 单元测试（纯逻辑）
```

## 开发

```bash
npm install
npm run build        # 产出 dist/（可直接加载的未打包扩展）
npm run typecheck    # tsc --noEmit
npm run test         # vitest 单元测试
npm run smoke        # 无头 Edge 端到端冒烟测试（需已构建）
npm run verify       # typecheck + test + build
```

加载扩展：浏览器打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 打开开发者模式 →
「加载已解压的扩展」选择 `dist/` 目录。

> 注意：正版 Chrome 的无头模式忽略 `--load-extension`，因此冒烟测试使用 Edge。

## 配置翻译服务

设置页 → 「翻译服务」。支持多个 Provider，单选当前生效的一个。

### OpenAI-compatible

| 字段 | 示例 |
|---|---|
| Base URL | `https://api.openai.com/v1`（DeepSeek：`https://api.deepseek.com/v1`，Ollama：`http://localhost:11434/v1`） |
| API Key | `sk-...` |
| 模型 | `gpt-4o-mini` / `deepseek-chat` / ... |

请求发往 `POST {baseUrl}/chat/completions`，携带 system/user message、temperature、max_tokens。
批量翻译要求模型返回 JSON 数组；解析失败时小批量自动降级为逐条请求。

Prompt 模板变量：`{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`。

### custom-http

- Body 模板（JSON，占位符 `{{texts}}`（数组）/ `{{text}}`（单条）/ `{{sourceLanguage}}` 等）；
- 响应字段路径（点号路径，如 `data.translations`）；
- API Key 可放 Header / Query / Body；
- 不含 `{{texts}}` 时自动逐条请求。

「测试连接」按钮会用 `Hello, world!` 实际调用一次验证配置。

## 架构要点

- **Provider 抽象**（`src/providers/provider.ts`）：`registerProviderFactory(type, factory)`
  为后续 DeepL / Azure / Ollama / **本地 Native Host** / 企业网关预留扩展点；
  UI 与 Content Script 中不存在任何具体 API 逻辑。
- **Background Service Worker**：请求队列 + 80ms 批量合并窗口、有界并发、
  超时 / 重试 / 错误分类（network/timeout/auth/rate_limit/server/invalid_response/config）、
  环形错误日志（50 条），不操作 DOM。
- **Content Script**：扫描 → 过滤 → 任务 → 渲染；原文子节点在首次替换前保存，
  保证 100% 可恢复；双语块/气泡全部带命名空间类名，气泡在 Shadow DOM 内，不污染页面。
- **消息协议**：`src/messaging/messages.ts` 中全量类型化（`RuntimeMessage` / `TabCommand`）。

## 已知限制（1.0 范围内刻意不做）

- 「译文模式」下段落整体替换为纯文本，段内链接/加粗等标记在该模式下不保留
  （双语对照模式完整保留原文结构）；
- 不穿透 Shadow DOM / iframe / 虚拟列表；
- 批量结果与条目数不匹配且批量较大时报错而非猜测；
- 划词翻译、PDF/图片/视频翻译不在 1.0 范围。

## 规格覆盖（对照 PolyPage.md）

- §7.1 五种显示模式、Popup 快切、默认模式、缓存复用、原文可恢复 ✔
- §7.2 Popup 触发 / 恢复 / 模式切换 / 自动翻译 / 快捷键 ✔
- §7.3 候选与跳过元素清单、8 条基础过滤规则 ✔
- §7.4 Tooltip 13 项要求（Shadow DOM、限宽限高、延迟关闭、翻译中/失败态等）✔
- §7.5 沉浸式双语 10 项要求（原文下方插入、样式、失败重试、可移除、手动重扫）✔
- §7.6 / §8 Provider 抽象、16 个配置字段、2 种 Provider 类型、超时/取消/重试/错误分类 ✔
- §8.3 Prompt 14 项约束（只输出译文、保留 URL/邮箱/代码/占位符、结构化批量返回等）✔
- §9 完整翻译流程（扫描→过滤→任务→后台批量→渲染→缓存→失败重试→恢复原文）✔
- §10 Background / Content / Popup / Options 职责划分与隔离（密钥不进内容脚本）✔
- §11 目录结构 ✔（构建脚本与测试脚本位于 `scripts/`、`tests/`）

## 验证

- `npm run typecheck`：strict TypeScript 零错误；
- `npm run test`：33 个单元测试（模板渲染、批量响应解析、文本过滤、设置规范化等）；
- `npm run build`：产出 dist 并校验 manifest 引用的全部文件存在；
- `npm run smoke`：无头 Edge 加载真实扩展，对 mock OpenAI API 完成
  扫描→批量翻译→双语渲染→模式切换→悬停气泡→恢复原文 的 19 项端到端断言。
