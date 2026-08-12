# 项目规划文档：网页翻译浏览器插件 2.0

## 0. 给 Agent 的总指令

本文档是 **2.0 版本的规划文档**，基于 `PolyPage.md`（1.0 规格）制定。1.0 已交付并验证
（strict TypeScript、33 单元测试、21 项无头浏览器端到端断言全部通过，仓库 `Skymly/PolyPage`）。

2.0 的主题是：

> **把 1.0 预留的扩展点全部兑现，并把"能用"提升为"好用、广用"。**

四大支柱（按用户确认，全部纳入 2.0）：

1. **支柱 A：本地 Native Host / C#/.NET 网关** —— 落地 1.0 §0 预留的本地 Host 扩展点；
2. **支柱 B：更广网站兼容** —— Shadow DOM、iframe、虚拟列表、站点规则；
3. **支柱 C：更强翻译体验** —— 划词翻译、段内 inline 对照、流式翻译、术语表；
4. **支柱 D：更多翻译服务** —— DeepL / Azure / Google / Ollama 等 Provider 与预设市场。

请严格遵循以下原则：

1. 1.0 功能零回退：所有 1.0 的显示模式、触发方式、消息协议保持向后兼容；
2. 每个里程碑产出可加载、可运行、可验证的扩展版本（延续 1.0 原则 10）；
3. 新增翻译服务必须走 Provider 抽象（`registerProviderFactory`），禁止在 UI / Content Script 写具体 API 逻辑；
4. Native Host 是**可选依赖**：未安装 Host 时插件功能与 1.0 等价，不得报错阻塞；
5. 敏感信息（API Key）继续只存于后台/本地 Host，内容脚本零接触；
6. 优先保证页面稳定性：新增 DOM 操作必须可完全恢复，延续原文保存/恢复机制；
7. 设置结构升级必须提供自动迁移（schemaVersion 1 → 2），不得破坏 1.0 用户配置；
8. 每项新功能必须补充对应层级的验证（单元测试 / 冒烟测试扩展），延续 1.0 验证文化；
9. 仍优先支持 Chrome 和 Edge，Manifest V3，不引入远程代码执行机制。

---

## 1. 项目名称

Web Translator Extension **2.0**

可简称为：

> Web Translator 2.0 / PolyPage 2.0

---

## 2. 与 1.0 的关系

1. 1.0 的 Provider 抽象、消息协议、存储层、渲染层全部保留并演进，不推倒重来；
2. 1.0 §8 预留的 `registerProviderFactory` 扩展点在 2.0 首次被第三方形态
   （`native-host` Provider）正式使用，用于验证该扩展点设计是否足够；
3. 1.0 的 `{{glossary}}`、`{{domain}}` 模板变量在 2.0 获得真实数据来源（术语表、页面域名）；
4. 1.0 标注"不强制支持"的 Shadow DOM / iframe / 虚拟列表（§7.5）在 2.0 升级为正式目标；
5. 1.0 标注"后续增强"的划词翻译（§4.9）在 2.0 升级为正式功能；
6. 1.0 的构建管线（`scripts/build.mjs` 四段构建）、图标生成、冒烟测试框架
   （`scripts/smoke-test.mjs` + mock API）直接复用并扩展。

---

## 3. 2.0 版本目标

按优先级分为 P0（必须）、P1（应当）、P2（尽力）：

### P0

1. `native-host` Provider 类型上线，通过 Native Messaging 与本地网关通信；
2. C#/.NET 本地网关（Native Messaging Host）MVP：stdio 收发、translate 路由、ping/health；
3. 网关安装器（Windows）：写入 NativeMessagingHosts 注册表、生成 manifest、一键卸载；
4. DeepL、Azure Translator、Google Translate、Ollama 四个 Provider 上线；
5. Provider 预设（一键模板）与故障转移（failover）链；
6. 划词翻译：选中即现悬浮按钮，点击出译文面板；
7. Shadow DOM（open root）扫描与翻译；
8. iframe（同源与跨源，all_frames）翻译与跨 frame 状态聚合；
9. 站点规则：include/exclude 选择器、按站点默认模式；
10. 设置 schema v2 与自动迁移；
11. 全部新增功能的单元测试 + 冒烟测试扩展。

### P1

1. 虚拟列表适配：IntersectionObserver 视口惰性翻译 + 回收重译；
2. 段内 inline 双语对照（新增显示模式 `inline`，保留原文标记结构）；
3. 流式翻译（OpenAI-compatible SSE），打字机式渲染；
4. 术语表管理 UI（全局术语表，注入 `{{glossary}}`）；
5. Provider 健康统计：测试连接显示延迟，错误日志按 Provider 归因；
6. 双语页面导出（HTML / Markdown 快照）；
7. 右键菜单：翻译此页 / 翻译选中文字（`contextMenus` 权限）。

### P2

1. 站点规则分享（导入/导出规则文件）；
2. 划词翻译增强：发音、复制到剪贴板、快捷键重复上一次划词；
3. 页面语言自动检测（用于 sourceLanguage=auto 时的提示）；
4. 翻译质量反馈入口（标记坏句 → 写入错误日志/导出）；
5. Ollama 之外本地后端的网关适配样例（llama.cpp server）。

---

## 4. 2.0 非目标

以下内容 2.0 不实现（经确认延续 1.0 边界或明确延后）：

1. **不实现 PDF 翻译**（延后至 2.x/3.0）;
2. **不实现图片 OCR 翻译**（延后至 2.x/3.0）；
3. **不实现视频字幕翻译**（延后至 2.x/3.0）；
4. 不实现账号系统、云端配置同步、多用户配额（延续 1.0）；
5. 不实现 Firefox / Safari 适配（Safari 需要完全不同的打包模型，单独立项）；
6. 不实现移动端；
7. 不实现复杂的可视化网站规则编辑器（规则仍为结构化表单 + JSON，不做拖拽式）；
8. 不随插件分发模型权重（本地模型由网关编排用户自装的 Ollama / llama.cpp）；
9. 不实现 Chrome Web Store 上架全部隐私合规材料（延续 1.0，仅遵守 MV3 规范）；
10. 不实现企业级审计日志与集中管控；
11. 不实现自动更新服务端（扩展与网关均走手动/商店更新）。

---

## 5. 支柱 A：本地 Native Host / C#/.NET 网关

### 5.1 总体架构

```text
┌────────────────────────────┐        chrome.runtime.connectNative        ┌─────────────────────────────┐
│  扩展 Background (MV3 SW)   │  ───────────────────────────────────────▶ │  PolyPage Gateway (.NET 8)  │
│  native-host Provider      │   Native Messaging (stdio, 长度前缀 JSON)   │  NativeMessagingHost        │
└────────────────────────────┘  ◀───────────────────────────────────────  └──────────────┬──────────────┘
                                                                                          │ 路由
                                                                  ┌───────────────────────┼───────────────────────┐
                                                                  ▼                       ▼                       ▼
                                                         本地模型后端               企业内网网关              云端 API 代理
                                                     (Ollama / llama.cpp)        (HTTP 内网翻译服务)       (代持 API Key)
```

要求：

1. 网关进程由浏览器按需拉起（Native Messaging 标准行为），空闲自动退出；
2. 扩展通过 `ping` 探测网关是否安装/在线，未安装时 Provider 显示「未安装」引导态；
3. 网关持有自己的后端凭据存储（本地加密文件），浏览器侧不再需要这些 Key；
4. 网关不可用时，按 §5.6 的故障转移策略回退到云端 Provider；
5. 网关与扩展之间不传输明文凭据（凭据在网关本地，翻译请求只传文本与语言参数）。

### 5.2 通信协议

1. 传输层：Native Messaging 标准帧（32 位小端长度前缀 + UTF-8 JSON）；
2. 应用层：JSON-RPC 2.0；
3. 必须支持的方法：

| 方法 | 说明 |
|---|---|
| `ping` | 探活，返回协议版本 |
| `capabilities` | 返回网关支持的后端列表、是否支持流式、批量上限 |
| `translate` | 批量翻译：`{ texts[], source, target, backend?, stream? }` |
| `translate.stream` | 流式翻译（逐块 `onData` 通知，JSON-RPC notification） |
| `cancel` | 按请求 id 取消 |
| `backends.list` | 列出可用后端（ollama 模型列表等） |
| `health` | 各后端健康状态与最近错误 |

4. 单条消息遵守 Native Messaging 1MB 上限（网关→扩展方向）：超大批量由扩展侧
   按 `maxBatchChars` 预切分，网关不做大包拆分；
5. 错误返回 JSON-RPC error，`code` 沿用 1.0 `ErrorKind` 语义映射
   （-32001 network / -32002 timeout / -32003 auth / -32004 rate_limit /
   -32005 server / -32006 invalid_response / -32007 config）。

### 5.3 Provider 集成

1. 新增 `ProviderType: 'native-host'`，通过 `registerProviderFactory('native-host', ...)` 注册；
2. `native-host` Provider 配置字段（在 1.0 §8.1 基础上的差异）：

| 字段 | 说明 |
|---|---|
| hostName | Native Host 名称，默认 `com.skymly.polypage.gateway` |
| backend | 网关后端 id（如 `ollama:qwen2.5`、`gateway:corp-http`），空为网关默认 |
| fallbackProviderId | 网关不可用时的回退 Provider id（可为空） |

3. `baseUrl/apiKey/model` 等云端字段对 native-host 类型不适用，Options UI 按类型隐藏；
4. 连接生命周期：首个 translate 请求时 `connectNative`，空闲超时（默认 60s 无请求）主动断开；
   长连接 Port 同时用于 MV3 Service Worker 保活；
5. 取消语义：页面恢复原文 / 模式切换时对未完成请求发 `cancel`。

### 5.4 C#/.NET 网关实现要求

1. 目标框架 .NET 8，`PublishSingleFile + SelfContained`，产出单 exe（x64）；
2. 标准输入输出读写 Native Messaging 帧，禁止阻塞式死锁（读写分离任务）；
3. 后端接口 `IGatewayBackend`：`TranslateAsync(batch, ctx, ct)` / `Capabilities`，
   与扩展侧 Provider 抽象同构，方便测试；
4. 内置后端：
   - `OllamaBackend`：HTTP 调 `http://localhost:11434/v1/chat/completions`（OpenAI 兼容）；
   - `HttpBackend`：通用 HTTP JSON 转发（复用 1.0 custom-http 的模板思想：body 模板 + 响应路径）；
5. 凭据存储：`%LocalAppData%\PolyPage\gateway.json`，Windows DPAPI 加密敏感字段；
6. 日志：`%LocalAppData%\PolyPage\logs\`，滚动保留 7 天；
7. 仓库内位置：`native-host/`（C# 解决方案），与扩展共享协议定义（JSON schema 或手写双份 + 契约测试）。

### 5.5 安装器（Windows）

1. 形态：单 exe 安装向导（可用网关本体 `--install` 子命令实现，不额外引入安装包框架）；
2. 职责：
   - 复制网关到 `%LocalAppData%\PolyPage\`；
   - 写入 Chrome 与 Edge 的 `NativeMessagingHosts` 注册表项（HKCU，无需管理员）；
   - 生成 host manifest（`name/description/path/type=stdio/allowed_origins`）；
   - `allowed_origins` 需要扩展 ID：发行版从商店/固定 ID 获取，开发态支持 `--allow <origin>` 追加；
3. 卸载：`--uninstall` 移除注册表项与文件；
4. 安装状态在 Options 页可检测（`ping` 成功/失败 + 版本号）。

### 5.6 故障转移（Failover）

1. 设置新增有序 `failoverChain: string[]`（Provider id 列表）；
2. 触发条件：活动 Provider 在重试用尽后仍为可重试错误（network/timeout/rate_limit/server）
   或 native-host 未安装/连接失败（config）；
3. 行为：按链条顺序尝试下一个 Provider，成功后记录「实际提供方」到错误日志与 Popup 状态；
4. 链条上全部失败才向页面报失败；
5. 故障转移只对整批生效一次，不在单条粒度上扇出（避免请求风暴）。

---

## 6. 支柱 B：更广网站兼容

### 6.1 Shadow DOM

1. 扫描器递归进入 `element.shadowRoot`（仅 open mode，closed 无法访问，作为已知限制记录）；
2. 每个被修改的 shadow root 注入样式克隆（1.0 的 content.css 在 shadow 内不生效）；
3. 双语块/悬停气泡的归属：插入到目标元素所在 root（document 或 shadow root）；
4. Tooltip 宿主仍挂在顶层 document，不受影响；
5. 验证：冒烟测试 fixture 页面包含 open shadow root 段落。

### 6.2 iframe

1. manifest `content_scripts` 增加 `all_frames: true`；
2. 每个 frame 独立 PageTranslator 实例，互不共享 DOM 映射；
3. Popup 状态聚合：Background 按 `sender.frameId` 汇总各 frame 的 PageState；
4. 命令广播：Popup 操作发送到 tab 的全部 frame（`tabs.sendMessage` 默认行为），
   无 content script 的 frame 静默失败；
5. 顶层页面恢复原文时同步广播恢复所有 frame；
6. 跨源 iframe 依赖 `<all_urls>` host 权限（1.0 已具备）；
7. 黑名单按顶层域名生效，frame 内页面不单独判定；
8. 验证：fixture 页面嵌套同源 + 跨源（本地双端口）iframe。

### 6.3 虚拟列表

1. 对候选节点可选挂载 IntersectionObserver：进入视口才提交翻译任务；
2. 虚拟滚动回收导致节点复用/内容变化时，经 MutationObserver 检测文本变化并重译
   （原文映射按元素 + 文本哈希校验失效）；
3. 页面级预算：单页待翻译条目超过阈值（默认 500）时自动降级为「仅视口翻译」并在 Popup 提示；
4. 作为站点规则的可选开关（默认关闭，按站点启用），避免普通页面额外开销。

### 6.4 站点规则

1. 规则结构：

```json
{
  "id": "rule-example",
  "match": ["example.com", "*.example.com"],
  "includeSelectors": ["article .content"],
  "excludeSelectors": [".ad", ".comments"],
  "minTextLength": 10,
  "defaultMode": "bilingual",
  "viewportOnly": false,
  "enabled": true
}
```

2. 匹配顺序：精确域名 > 通配符；多条命中时字段按优先级合并（显式 > 默认）；
3. 应用位置：scanner（选择器过滤）、translator（默认模式）、index（minTextLength）；
4. Options 提供列表式规则编辑器（增删改 + 启用开关 + JSON 预览），不做可视化拖拽；
5. 内置少量默认规则（随版本更新），用户规则优先；
6. 导入/导出：JSON 文件，与设置导出分离。

---

## 7. 支柱 C：更强翻译体验

### 7.1 划词翻译

1. 触发：`mouseup` / `keyup`（Shift 方向键）后检测 Selection，长度 1–500 字符；
2. 触发策略可配置：总是显示 / 按住 Alt 时显示 / 关闭；
3. UI：选区末尾悬浮小按钮（Shadow DOM 宿主，pointer-events 按需开启），
   点击展开译文面板（译文 + 复制按钮 + 收起）；
4. 复用后台翻译管线（单条请求 + 缓存），不新建 API 通路；
5. 面板不插入页面正文 DOM（Shadow DOM 宿主挂 documentElement）；
6. 与页面翻译相互独立：划词翻译在黑名单站点同样禁用；
7. 权限：新增可选 `contextMenus`，右键「翻译选中文字」走同一管线（P1）。

### 7.2 段内 inline 双语对照

1. 新增显示模式 `inline`（第六种模式）：在句子/文本片段旁内联显示译文，保留原文标记结构；
2. 实现：对候选元素做文本节点级拆分，批量请求（仍走 80ms 合并窗口），
   渲染为 `<span class="wt-inline-src">` + `<span class="wt-inline-dst">` 相邻结构；
3. 请求量控制：
   - 相邻短文本节点合并为一条任务；
   - 单页 inline 任务预算（默认 300 条），超预算元素降级为段落级双语并提示；
4. 恢复原文：按 1.0 的 originalNodes 保存机制原样还原；
5. 样式：译文以弱化颜色/下划线区分，跟随明暗主题；
6. 验证：fixture 页面含 `<a>`、`<strong>` 等内联标记，断言翻译后标记保留。

### 7.3 流式翻译

1. `openai-compatible` Provider 增加 `stream: true` SSE 支持；
2. Provider 抽象新增可选能力 `translateStream(text, ctx, onDelta, signal)`
   （不支持流式的 Provider 回退为一次性返回）；
3. 适用场景：单段大文本与 `inline` 模式首屏；批量合并请求默认不流式（吞吐优先）；
4. 渲染：双语块/inline 译文增量更新，结束后落缓存；
5. 取消：恢复原文时 AbortController 终止 SSE；
6. 验证：mock API 增加 SSE 端点，冒烟断言增量到达与最终一致。

### 7.4 术语表

1. 全局术语表：`[{ source, target, note? }]`，存 settings（schema v2）；
2. 渲染为 `{{glossary}}` 变量内容（`source = target` 逐行），注入 system prompt；
3. Options 提供表格编辑（增删改、批量粘贴导入 `src=dst` 行）；
4. 术语表变更会使缓存键失效吗？——不。术语表影响 Prompt，缓存键加入术语表版本哈希
   （`glossaryVersion` 计数，编辑 +1），避免旧缓存污染。

### 7.5 双语导出（P1）

1. 导出当前页为双语 HTML（原文 + 译文块，内联样式）与 Markdown（`> 译文` 引用块）；
2. 仅导出已翻译完成条目，未完成项标注「（未翻译）」；
3. 通过 Options/Popup 触发下载。

---

## 8. 支柱 D：更多翻译服务

### 8.1 新增 Provider

| Provider | 类型 | 端点 | 认证 | 说明 |
|---|---|---|---|---|
| DeepL | `deepl` | `POST {baseUrl}/v2/translate` | `Authorization: DeepL-Auth-Key` | 支持 formality 参数 |
| Azure Translator | `azure-translator` | `POST {baseUrl}/translate?api-version=3.0` | `Ocp-Apim-Subscription-Key` + Region | 返回数组结构 |
| Google Translate | `google-translate` | `POST {baseUrl}/v2` 或 v3 | API Key / OAuth（2.0 仅 API Key） | v2 简化版 |
| Ollama | `openai-compatible`（预设） | `http://localhost:11434/v1` | 无 | 以预设模板形态提供，不新增类型 |
| native-host | 见支柱 A | Native Messaging | 网关本地凭据 | 新类型 |

要求：

1. 每个新类型独立文件 + `registerProviderFactory` 注册，公共 HTTP/重试/超时逻辑复用
   `provider.ts` 的 `withTimeoutAndRetry` 与错误分类；
2. 批量优先：DeepL/Azure/Google 均支持一次请求多文本；
3. 响应解析失败归为 `invalid_response` 并给出响应路径提示。

### 8.2 Provider 预设市场

1. `src/providers/presets.ts`：内置预设数组（OpenAI / DeepSeek / Moonshot / OpenRouter /
   Ollama / DeepL / Azure / Google / 企业网关样例）；
2. 每个预设含：name / type / baseUrl / model / prompts / bodyTemplate / responsePath 推荐值；
3. Options「从预设创建」入口，创建后用户只需填 API Key；
4. 预设随版本更新，不影响用户已创建的 Provider 实例。

### 8.3 Provider 运维能力（P1）

1. 测试连接返回耗时（ms）并显示；
2. 错误日志条目附 Provider id/name，Options 可按 Provider 过滤；
3. 每 Provider 滑动窗口统计（近 50 次：成功率、平均耗时），显示在列表行；
4. 统计只存内存 + 会话级，不持久化（避免存储膨胀）。

---

## 9. 架构演进

### 9.1 模块增量（在 1.0 §10 基础上）

| 模块 | 变化 |
|---|---|
| providers | 新增 `native-host.ts` / `deepl.ts` / `azure-translator.ts` / `google-translate.ts` / `presets.ts`；`provider.ts` 增加流式可选接口 |
| background | 新增 NativeMessaging 连接管理、frame 状态聚合、failover 链执行、contextMenus |
| content | scanner 增加 shadow/iframe 感知；新增 `selection.ts`（划词）、`rules.ts`（站点规则应用）、inline 渲染分支；observer 增加视口模式 |
| messaging | 消息协议加 `v: 2` 字段；新增 frame 聚合状态消息与流式增量消息 |
| storage | settings schema v2（术语表、规则、failoverChain、划词配置）；迁移函数 |
| options | Provider 类型分形表单、预设入口、术语表、规则编辑器、Host 安装状态 |
| popup | 多 frame 进度聚合、failover 实际提供方提示、划词开关 |

### 9.2 消息协议 v2

1. 所有 RuntimeMessage 增加 `v: 2`（v 缺省按 v1 处理，兼容 1.0 内容脚本）；
2. 新增：`translate-stream`（背景→订阅式推送 delta）、`frame-state`（聚合）、
   `host-status`（网关状态查询）；
3. TabCommand 新增：`wt:translate-selection`（右键菜单触发）。

### 9.3 设置 schema v2

1. `schemaVersion: 2`；`normalizeSettings` 延续 1.0 的宽容归一化风格；
2. 新增字段（全部可缺省，缺省走默认）：
   `glossary`、`glossaryVersion`、`siteRules`、`failoverChain`、
   `selectionTranslate: 'always'|'alt'|'off'`、`inlineBudget`、`viewportBudget`；
3. v1 → v2 迁移：仅补默认值，不清空任何已有字段；v2 设置可被 1.0 代码安全读取
   （1.0 归一化忽略未知字段——由 1.0 `normalizeSettings` 行为保证，需补回归测试）。

### 9.4 权限变化

| 权限 | 状态 | 用途 |
|---|---|---|
| `storage` | 保留 | 设置/缓存 |
| `<all_urls>` host | 保留 | 跨源 iframe、任意 API 端点 |
| `nativeMessaging` | **新增** | 本地网关 |
| `contextMenus` | **新增** | 右键翻译（P1） |

---

## 10. 推荐目录结构（2.0 增量）

```text
PolyPage/
├── native-host/                      # ★ 新增：C#/.NET 网关
│   ├── PolyPage.Gateway/             #   网关主体（stdio、后端路由）
│   ├── PolyPage.Gateway.Backends/    #   Ollama/Http 后端实现
│   └── PolyPage.Gateway.Tests/       #   协议契约测试
├── src/
│   ├── providers/
│   │   ├── native-host.ts            # ★
│   │   ├── deepl.ts                  # ★
│   │   ├── azure-translator.ts       # ★
│   │   ├── google-translate.ts       # ★
│   │   └── presets.ts                # ★
│   ├── content/
│   │   ├── selection.ts              # ★ 划词翻译
│   │   ├── rules.ts                  # ★ 站点规则应用
│   │   └── ...(1.0 文件演进)
│   └── ...(1.0 结构保持)
├── tests/                            # 扩充：规则匹配、inline 拆分、协议帧、迁移
└── scripts/
    └── fixtures/                     # ★ 冒烟测试夹具页（shadow/iframe/SSE/mock host）
```

---

## 11. 里程碑与阶段安排

按风险从低到高排序；每个里程碑结束时必须满足「可加载 + 冒烟全绿 + 1.0 用例零回退」。

### M1 —— Provider 与体验速赢（支柱 D + 支柱 C 前半）

1. DeepL / Azure / Google / Ollama 预设上线；
2. Provider 预设入口、测试连接显示延迟；
3. 术语表（存储 + 注入 + 缓存键版本化）；
4. 划词翻译 MVP；
5. 设置 schema v2 与迁移回归测试。

退出标准：新 Provider 对 mock 服务端冒烟通过；划词在 fixture 页断言通过；
1.0 全部 21 项冒烟断言保持通过。

### M2 —— 网站兼容（支柱 B）

1. Shadow DOM 扫描/渲染 + 样式注入；
2. iframe all_frames + 状态聚合；
3. 站点规则（存储、编辑器、scanner 应用）；
4. 虚拟列表视口翻译（规则开关）。

退出标准：shadow/iframe fixture 冒烟通过；规则命中/合并逻辑单元测试通过；
普通页面性能无显著退化（扫描耗时对比 1.0 基线 ±20% 内）。

### M3 —— 本地 Host 与高级渲染（支柱 A + 支柱 C 后半）

1. native-host Provider + NativeMessaging 连接管理；
2. C#/.NET 网关 MVP（ping/capabilities/translate/cancel + Ollama/Http 后端）；
3. Windows 安装器（安装/卸载/状态检测）；
4. failover 链；
5. 流式翻译（SSE + 增量渲染）；
6. inline 显示模式；
7. 双语导出、右键菜单（P1 项）。

退出标准：mock native host（Node 仿真进程）契约测试通过；
真实 .NET 网关在开发机手动联调记录在案；流式/inline 冒烟通过；
failover 断言（主 Provider 宕机 → 备 Provider 成功）通过。

---

## 12. 验收与验证要求

延续 1.0 的分层验证：

1. **单元测试**（vitest）新增覆盖：
   - JSON-RPC 帧编解码与 1MB 边界；
   - 站点规则匹配合并；
   - inline 文本节点拆分与预算；
   - schema v1→v2 迁移与 v2→v1 读兼容；
   - 各新 Provider 的请求构造/响应解析（对固定报文）。
2. **冒烟测试**（无头浏览器 + mock 服务）新增夹具：
   - open shadow root 页面；
   - 同源 + 跨源 iframe 页面（双本地端口）;
   - SSE 流式端点；
   - mock native host（Node 可执行文件 + 测试用 NativeMessaging manifest）；
   - 划词选区模拟。
3. **手动联调清单**（记录结果入库）：
   - 真实 Ollama 本地模型经网关翻译；
   - 安装器在干净 Windows 用户配置下的安装/卸载；
   - 1.0 老设置文件导入 2.0 后全部功能正常。
4. **回归门槛**：任一里程碑合入前，1.0 的 33 单元测试 + 21 项冒烟断言必须全绿。

---

## 13. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| NativeMessaging 1MB 帧限制 | 大批量翻译失败 | 扩展侧按 maxBatchChars 预切分；网关不做二次拆分 |
| MV3 Service Worker 休眠 | 长翻译/流式中断 | native port 保活 + 分块幂等续译（2.0 先保活，续译记为 2.1 备选） |
| 开发态扩展 ID 不固定 | allowed_origins 配置困难 | 安装器 `--allow <origin>` 追加；发行态固定 ID |
| inline 模式请求量爆炸 | 费用与限流 | 合并相邻节点 + 页面预算 + 超预算降级 |
| 跨源 iframe 的站点反注入 | 部分站点不可译 | 明确列为已知限制；站点规则可禁用该 frame 翻译 |
| Chrome 政策变化（host_permissions 审查） | 上架受阻 | 2.0 仍以本地分发为主；保持权限最小化说明文档 |
| C# 工具链缺失的协作者 | 无法构建网关 | 网关与扩展完全解耦：无网关时插件 = 1.0 功能集 |

---

## 14. 术语表（2.0 新增）

| 术语 | 定义 |
|---|---|
| 网关 / Gateway | 2.0 引入的本地 Native Messaging Host（C#/.NET 进程），负责路由翻译请求到本地或远程后端 |
| 后端 / Backend | 网关内部的翻译执行器（OllamaBackend、HttpBackend 等） |
| failover 链 | 有序 Provider 列表，主 Provider 失败时按序接管 |
| 预设 / Preset | 一键创建 Provider 的模板（端点、Prompt、响应路径推荐值） |
| 站点规则 | 按域名匹配生效的扫描/模式/预算配置 |
| inline 模式 | 第六种显示模式：段内文本片段级双语对照 |
| 视口翻译 | 仅翻译进入视口节点的惰性策略（虚拟列表适配） |
| 术语表版本 | 术语表内容变更计数，参与缓存键，防止旧缓存污染 |
