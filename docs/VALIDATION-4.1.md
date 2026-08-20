# VALIDATION-4.1

4.1 收口记录（schema v5 / 消息协议 v5 / 网关 4.1.0 协议仍为 2）。
验证日期：2026-08-18。

## 1. 自动回归

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | **214** 通过（含 MiniMax `<think>` 剥离） |
| `npm run smoke` | **SMOKE TEST: ALL PASSED (125 assertions)** |
| `dotnet test native-host/PolyPage.slnx` | 32 通过 |
| `node scripts/gateway-contract-test.mjs` | ALL PASSED，`protocol === 2` |

导航菜单 `原文[译文]` 冒烟仍绿。

## 2. P0 手动 / 真机

### 7.1 Firefox 网关真联调

自动已核验：

- [x] `gecko.id` = `polypage@skymly.com` 与安装器 `DefaultGeckoId` 一致
- [x] `--install` 写入 `*.firefox.json`，`allowed_extensions` 含 `polypage@skymly.com`
- [x] `HKCU\Software\Mozilla\NativeMessagingHosts\com.skymly.polypage.gateway` 指向该 manifest
- [x] `--status` 打印 Mozilla 键
- [ ] Firefox 进程内 `connectNative` ping + 一笔 `translate`：本机已有交互 Firefox；Marionette 临时加载脚本未在占用环境下起来。Computer Use 对 Firefox 仍被 URL 策略拦截。请 `about:debugging` 临时加载 `dist-firefox/manifest.json` 后点 Options「检测网关」

未安装时 failover 文案 + 冒烟 failover 已覆盖。

### 本机 Ollama（qwen3-14b-64k）

- [x] 直连 `/v1/chat/completions`（`OLLAMA_ORIGINS=*`）
- [x] `node scripts/ollama-live-check.mjs` 页面出现中文译文
- 备注：该模型会夹带 thinking 文本

### MiniMax Token Plan（环境变量 `MiniMax`，多模态）

- [x] Token Plan key（`sk-cp-`）走 `https://api.minimax.chat/v1`（`api.minimax.io` 返回 401）
- [x] 文本：`Open source software changed the world.` → `开源软件改变了世界。`
- [x] 视觉直连：夹具 `HELLO WORLD` → `[{"text":"HELLO WORLD","translation":"你好世界"}]`
- [x] `node scripts/minimax-live-check.mjs`：扩展管线 `wt:translate` + `ocr-request`（`llm-vision`）均成功
  - 文本块：`开源软件改变了世界。`
  - OCR：`engine=llm-vision`，`HELLO WORLD` / `你好世界`
- Options 增加 MiniMax 预设（`MiniMax-M3`）；对 MiniMax 请求自动带 `thinking: { type: "disabled" }`；视觉解析剥离 `<think>`

### OCR 语言包

- [x] 清单 + 哈希失败重试单测
- [x] 真下载 `fra.traineddata` 1,130,365 字节，SHA-256 与目录钉死值一致

## 3. P1 / P2

- [x] ASR 流式：无后端则 4.0 一次注入
- [x] 图片原位覆盖默认关
- [x] PDF 偏双栏预设单测

## 4. 遗留（可顺延 4.2）

- Firefox 进程内 connectNative 仍需人工在 about:debugging 勾一次
- 真实 Whisper 仍无本机权重
- qwen3 思考链污染译文（Ollama 侧）
- 原位覆盖复杂版面 / PDF 表格启发式上限
