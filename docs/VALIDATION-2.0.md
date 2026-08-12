# PolyPage 2.0 验证记录

日期：2026-08-13　环境：Windows（开发机）、Node v24.18.0、.NET SDK 10.0.302
（目标 net8.0，运行时 8.0.29）、Edge headless（`--headless=new`）、Ollama
localhost:11434（qwen3-14b-64k）。

对照 `PolyPage-2.0.md` §11 里程碑退出标准与 §12 验收要求。

---

## 1. 回归门槛（§12.4）

| 项 | 1.0 基线 | 2.0 结果 |
|---|---|---|
| strict TypeScript | 0 错误 | **0 错误** |
| 1.0 单元测试 | 33 通过 | **33/33 保留通过**（合计 78） |
| 1.0 冒烟断言 | 21 通过 | **21/21 保留通过**（合计 56） |

## 2. 单元测试（§12.1）— 78 个全部通过

- `tests/utils.test.ts` / `textFilters.test.ts` / `settings.test.ts`：1.0 原有 33 个；
- `tests/frames.test.ts`（9）：JSON-RPC 帧编解码、分块重组、UTF-8 多字节、
  **1MB 边界（恰好 1MB 通过 / 超限拒绝）**、错误码映射；
- `tests/rules.test.ts`（13）：域名/通配符匹配、精确优先排序、显式>默认合并、
  规则规范化、术语表渲染；
- `tests/inline.test.ts`（6，happy-dom）：inline 文本节点分段（内联标记合并、
  块级边界拆分）、src/dst 结构渲染、`<strong>` 标记保留、原文完整恢复；
- `tests/migration.test.ts`（8）：schema v1→v2 迁移（只补默认值、逐字段保留）、
  **v2 文档可被 1.0 式归一化安全读取**、新 Provider 类型字段归一化、
  failoverChain 去重去幽灵、术语表归一化；
- `tests/providers.test.ts`（9）：DeepL/Azure/Google 对固定报文的请求构造
  （端点/认证头/请求体）与响应解析、HTTP 状态→ErrorKind 映射、语言代码映射。

## 3. 冒烟测试（§12.2）— 56 项断言全部通过

`npm run smoke`（无头 Edge + mock API + 真实网关）：

- **1.0 用例零回退**：扫描→批量翻译→双语渲染→模式切换→悬停气泡（Shadow DOM
  隔离）→恢复原文 共 21 项；
- **站点规则**：include/exclude 命中（#p3 被排除）3 项；
- **inline 模式**：dst 片段插入、内联标记保留、原文可见、恢复后 span 清零、
  标记结构完整 6 项；
- **Shadow DOM**：open root 扫描计数、root 内双语块、样式克隆注入 4 项；
- **iframe**：3 frame 状态聚合、同域 frame 翻译、**跨源 frame（第二端口）翻译**、
  恢复广播到全部 frame 6 项；
- **划词翻译**：悬浮按钮出现、面板译文、面板不入页面 DOM 3 项；
- **SSE 流式**：流式端点命中、多增量到达、最终一致 3 项 + 动态节点悬停译文 2 项；
- **导出**：双语文本载荷 1 项；
- **网关与故障转移**：host-status 检测、native-host 经真实 .NET 网关翻译
  （`[gw]` 报文）、无失败、故障转移（未安装 host → 回退 mock 成功）、
  错误日志记录、Popup 实际提供方提示 8 项。

## 4. 网关契约测试（§12.1/§12.3）— 27 + 9 通过

- `dotnet test native-host/PolyPage.slnx`：27 个 xunit 契约测试（帧编解码含
  1MB 边界、ping/capabilities/translate/backends.list/health 路由、错误码映射、
  批量上限拒绝、未知后端/未知方法、流式 delta 通知序列、HttpBackend 对
  HttpListener 桩的报文构造/路径解析/500→server 映射）；
- `node scripts/gateway-contract-test.mjs`：启动**真实发布的单文件网关进程**，
  经真实 stdio Native Messaging 帧验证 ping / capabilities / translate /
  backends.list / health / 超批拒绝 / 未知方法 共 **9 项通过**。

## 5. 手动联调清单（§12.3）

### 5.1 真实 Ollama 本地模型经网关翻译 — ✅ 通过

`node scripts/gateway-ollama-check.mjs`（模型 qwen3-14b-64k:latest）：

```text
health: {"backends":[{"id":"ollama","kind":"ollama","ok":true,"detail":"Ollama 在线 (http://localhost:11434)"}]}
translate ok in 34184ms:
  - 开源软件改变了世界。
  - 请翻译这个句子。
translate.stream ok in 523ms, 11 deltas: "早上好，我的朋友。"（含模型 think 片段）
```

记录：批量两条全部准确；流式 11 个增量块。qwen3 思考模式会在流式输出中带
`<think>` 片段（模型行为，网关忠实透传）；建议对带思考的模型使用无思考
提示或模型参数规避（已记入 native-host/README.md 已知限制）。

### 5.2 安装器安装/卸载 — ✅ 通过（当前用户配置）

冒烟测试每轮自动执行：`PolyPage.Gateway.exe --install --allow
chrome-extension://<id>/` → HKCU 注册表（Chrome+Edge）+ manifest 写入 →
浏览器经 Native Messaging 拉起真实网关并完成翻译 → 测试结束 `--uninstall`
清理注册表与文件。`--status` 输出已验证。

> 说明：未单独建立干净 Windows 用户配置复测（需独立系统账户）；安装器全程
> HKCU 作用域、无管理员权限，逻辑路径与当前用户一致。

### 5.3 1.0 老设置文件导入 2.0 — ✅ 通过

- `tests/migration.test.ts` 以真实 1.0 设置文档断言：schemaVersion 升级为 2、
  全部 1.0 字段逐值保留、2.0 新字段补默认、内置规则补齐；
- 反向兼容：v2 文档经 1.0 式归一化读取不丢字段（1.0 忽略未知字段的保证）；
- 冒烟测试全部设置写入经真实 `save-settings` 消息路径（含归一化）。

## 6. 性能（M2 退出标准）

普通页面（无规则命中）扫描路径与 1.0 相同（deepQuerySelectorAll 在无 shadow
root 时等价于一次 querySelectorAll），1.0 全部扫描/翻译断言在相同时限内通过，
无显著退化。虚拟列表视口模式默认关闭、按站点规则启用，普通页面零额外开销。

## 7. 遗留与备注

1. 虚拟列表「回收重译」与「超预算降级仅视口」逻辑已实现并有单元覆盖
   （detectRecycledNodes / applyViewportBudget），未纳入无头冒烟（需要可滚动
   长页与真实 IntersectionObserver 时序，属手动验证项）；
2. Firefox/Safari、PDF/OCR/字幕按 2.0 非目标不实现（§4）；
3. 分块幂等续译（SW 休眠场景）按 §13 记为 2.1 备选，2.0 以端口保活覆盖。