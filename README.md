# PolyPage — Web Translator Extension

网页翻译浏览器插件 **2.0**（Chrome / Edge，Manifest V3，TypeScript + C#/.NET 本地网关）。

接入你自己的 **LLM / 翻译 API / 本地模型**，在任意网页上获得：

- 原文 / 译文 / 双语对照 / **段内 inline 对照** 等六种显示模式；
- 译文模式悬停看原文、原文模式悬停看译文（Shadow DOM 气泡，支持**流式打字机**渲染）；
- **划词翻译**：选中文字即出悬浮翻译按钮；
- **Shadow DOM / iframe（同源+跨源）/ 站点规则 / 虚拟列表视口翻译** 兼容；
- **DeepL / Azure Translator / Google Translate / Ollama** 预设与故障转移链；
- **本地 .NET 网关（Native Messaging Host）**：可选依赖，把请求路由到本机 Ollama
  或企业内网服务，凭据留在本机；
- 术语表、双语导出（HTML/Markdown）、右键菜单、翻译缓存、批量合并、超时/重试、错误分类与日志。

> 本项目按 `PolyPage.md`（1.0 规格）与 `PolyPage-2.0.md`（2.0 规划）实现，
> 验证记录见 `docs/VALIDATION-2.0.md`。

---

## 2.0 新特性（对照 PolyPage-2.0.md）

| 支柱 | 能力 |
|---|---|
| A 本地网关 | `native-host` Provider（Native Messaging + JSON-RPC 2.0）、C#/.NET 8 网关（Ollama/Http 后端、DPAPI 凭据、滚动日志）、Windows 免管理员安装器（`--install/--uninstall/--status`）、网关不可用时自动回退 |
| B 网站兼容 | open Shadow DOM 扫描+样式注入、iframe `all_frames` 翻译与多 frame 状态聚合、站点规则（include/exclude 选择器、按站点默认模式、仅视口）、虚拟列表视口惰性翻译与回收重译 |
| C 翻译体验 | 划词翻译（总是/按 Alt/关闭）、段内 inline 对照（预算内片段级、超预算降级）、OpenAI-compatible SSE 流式翻译、术语表（注入 {{glossary}}、版本号参与缓存键）、双语导出 HTML/Markdown、右键菜单 |
| D 翻译服务 | DeepL / Azure Translator / Google Translate 新 Provider、Ollama 等 9 个一键预设、故障转移链（failoverChain + native-host 专属回退）、Provider 会话统计（成功率/延迟）、错误日志按 Provider 过滤 |

设置结构升级为 schema v2，1.0 配置自动迁移（只补默认值，不清空任何字段）。

## 目录结构

```text
├── public/
│   ├── icons/                  # 构建脚本生成的图标
│   └── manifest.json           # MV3 清单（2.0：nativeMessaging/contextMenus/all_frames）
├── src/
│   ├── background/             # service-worker（队列/批量/failover/frame 聚合/流式端口）+ nativePort
│   ├── content/                # scanner(shadow 感知)/translator/renderer/tooltip/observer/selection/inline/rules
│   ├── popup/                  # 六模式、多 frame 聚合、划词开关、导出
│   ├── options/                # 预设/类型分形表单/术语表/站点规则/failover/网关状态
│   ├── providers/              # provider 抽象 + openai-compatible/custom-http/deepl/azure-translator/google-translate/native-host + presets
│   ├── storage/                # settings.ts（schema v2 + 迁移）+ cache.ts（术语表版本入键）
│   ├── messaging/messages.ts   # 协议 v2（全量类型化）
│   ├── shared/                 # types/constants/utils/textFilters/siteRules/nativeFrames/nativeRpc
│   └── styles/                 # content.css + tooltip.css（注入 Shadow DOM）
├── native-host/                # ★ C#/.NET 网关解决方案（PolyPage.slnx）
│   ├── PolyPage.Gateway/       #   stdio JSON-RPC 主机 + 安装器
│   ├── PolyPage.Gateway.Backends/  # Ollama/Http 后端 + 共享解析器
│   └── PolyPage.Gateway.Tests/ #   协议契约测试（xunit）
├── scripts/
│   ├── build.mjs               # 4 段 vite 构建 + dist 校验
│   ├── generate-icons.mjs      # 零依赖 PNG 图标生成
│   ├── smoke-test.mjs          # 无头 Edge 端到端冒烟（56 项断言）
│   ├── gateway-contract-test.mjs   # 真实网关 stdio 契约测试
│   └── gateway-ollama-check.mjs    # 真实 Ollama 经网关联调
├── tests/                      # vitest 单元测试（78 个）
└── docs/VALIDATION-2.0.md      # 里程碑验证记录
```

## 开发

```bash
npm install
npm run build        # 产出 dist/（可直接加载的未打包扩展）
npm run typecheck    # tsc --noEmit（strict）
npm run test         # vitest 单元测试（78）
npm run smoke        # 无头 Edge 端到端冒烟（需已构建；含网关安装/卸载）
npm run verify       # typecheck + test + build

# 网关
dotnet build native-host/PolyPage.slnx
dotnet test  native-host/PolyPage.slnx                     # 27 个契约测试
dotnet publish native-host/PolyPage.Gateway -c Release -r win-x64
node scripts/gateway-contract-test.mjs                     # 真实进程 stdio 协议测试
```

加载扩展：`chrome://extensions`（Edge 为 `edge://extensions`）→ 开发者模式 →
「加载已解压的扩展」选择 `dist/`。

> 注意：正版 Chrome 的无头模式忽略 `--load-extension`，因此冒烟测试使用 Edge。

## 配置翻译服务

设置页 → 「翻译服务」。**从预设创建**（OpenAI / DeepSeek / Moonshot / OpenRouter /
Ollama / DeepL / Azure / Google / 本地网关 / 企业 HTTP 样例）后通常只需填 API Key。
多个 Provider 可共存，单选当前生效；另可配置**故障转移链**。

- **openai-compatible**：`POST {baseUrl}/chat/completions`，支持 SSE 流式；
  本地端点（localhost/127.0.0.1）免 API Key。
- **deepl**：`POST {baseUrl}/v2/translate`，`Authorization: DeepL-Auth-Key`，支持 formality。
- **azure-translator**：`POST {baseUrl}/translate?api-version=3.0`，
  `Ocp-Apim-Subscription-Key` + 可选区域头，返回数组结构。
- **google-translate**：v2 简化版，API Key 走 query，输出自动解 HTML 实体。
- **custom-http**：Body 模板（`{{texts}}`/`{{text}}`/`{{sourceLanguage}}`…）+ 响应路径。
- **native-host**：`hostName`（默认 `com.skymly.polypage.gateway`）+ 网关后端 id +
  可选回退 Provider。网关安装见 `native-host/README.md`。

Prompt 模板变量：`{{sourceLanguage}} {{targetLanguage}} {{text}} {{texts}} {{domain}} {{glossary}}`
（2.0 起 `{{glossary}}`/`{{domain}}` 注入真实术语表与页面域名）。

## 站点规则与划词

- 站点规则：Options →「站点规则」，按域名（支持 `*.example.com`）配置
  include/exclude 选择器、最短长度、默认模式、仅视口开关；精确域名优先，
  显式字段覆盖默认；支持 JSON 导入/导出。
- 划词翻译：选中 1–500 字符出现悬浮按钮（Shadow DOM 宿主），点击展开译文面板
  （复制/收起）；触发策略可选「总是 / 按住 Alt / 关闭」；黑名单站点禁用。

## 架构要点

- **Provider 抽象**（`src/providers/provider.ts`）：`registerProviderFactory(type, factory)`
  在 2.0 由 `native-host` 正式使用；UI 与 Content Script 中不存在任何具体 API 逻辑。
- **Background Service Worker**：请求队列 + 80ms 批量合并窗口、有界并发、
  超时/重试/错误分类、**failover 链（整批粒度，一次接管）**、多 frame 状态聚合、
  NativeMessaging 连接管理（60s 空闲断开 + SW 保活）、流式端口、右键菜单、
  环形错误日志（50 条，按 Provider 归因）。
- **Content Script**：shadow 感知扫描 → 规则过滤 → 任务 → 渲染；原文子节点在首次
  替换前保存（inline 模式深克隆），保证 100% 可恢复；双语块/气泡/划词面板全部
  Shadow DOM 或命名空间类名隔离；虚拟列表回收经文本哈希校验重译。
- **消息协议 v2**：`src/messaging/messages.ts` 全量类型化，`v: 2` 标记，v1 兼容。

## 验证

- `npm run typecheck`：strict TypeScript 零错误；
- `npm run test`：**78 个单元测试**（1.0 的 33 个全部保留 + 2.0 新增：
  JSON-RPC 帧编解码与 1MB 边界、站点规则匹配/合并、inline 拆分与恢复、
  schema v1→v2 迁移与 v2→v1 读兼容、DeepL/Azure/Google 请求构造与响应解析）；
- `dotnet test native-host`：**27 个网关契约测试**；
- `npm run smoke`：无头 Edge 加载真实扩展，**56 项端到端断言**（1.0 的 21 项
  零回退 + inline/Shadow DOM/iframe 聚合/站点规则/划词/SSE 流式/导出/
  真实 .NET 网关翻译/故障转移）；
- 手动联调清单（真实 Ollama 经网关、安装器装/卸、v1 配置导入）记录于
  `docs/VALIDATION-2.0.md`。

## 已知限制

- 「译文模式」段落整体替换为纯文本（双语/段内模式保留标记结构）；
- closed Shadow DOM 无法进入（浏览器限制）；
- 跨源 iframe 依赖 `<all_urls>` 权限；个别站点反注入时可用站点规则禁用该 frame；
- MV3 SW 长任务依赖 native port / 流式端口保活，分块幂等续译列入 2.1 备选；
- PDF / 图片 OCR / 视频字幕 / Firefox / 移动端不在 2.0 范围（见 PolyPage-2.0.md §4）。