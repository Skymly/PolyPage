# VALIDATION-4.2

4.2 收口记录（schema v6 / 消息协议 v6 / 网关源码 4.2.0 协议仍为 2）。
验证日期：2026-08-19。

## 1. 自动回归

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | **233** 通过（4.1 的 214 零回退 + 卫生层 / v6 迁移 / 覆盖重算 / ASR 流式能力 / 表格夹具） |
| `npm run smoke` | **SMOKE TEST: ALL PASSED (128 assertions)** |
| `dotnet test native-host/PolyPage.slnx` | 32 通过 |
| `node scripts/gateway-contract-test.mjs` | ALL PASSED，`protocol === 2` |

4.1 断言零回退：导航菜单 `原文[译文]`、TM 第二页零新增 mock、schema 自动迁移到 v6。
带 `<think>` 的 mock 译文未出现在页面。

## 2. 支柱 P：译文卫生

- [x] `sanitize.ts` 单测：qwen3 `</think>` 残片、MiniMax 围栏 JSON、剥完为空、合法句子 `I think…`、开关关闭保留原文
- [x] v5→v6 只补 `outputSanitize` 默认；v6 可被 4.1 风格 `normalize` 忽略新字段读回
- [x] 后台 `runBatch` / `translate-cue` / 流式落盘 / OCR 译文在写缓存与 TM 前过卫生层；剥空视为 `invalid_response`
- [x] Options 可关卫生层；思考链剥离默认开
- [x] MiniMax Token Plan `sk-cp-` 误指 `api.minimax.io` 时 Options / HTTP 错误提示换 `api.minimax.chat`（文案不含 key）
- [x] 冒烟：带 `<think>` 的 mock 译文不出现在页面 / p3 译文无思考链残片

## 3. 支柱 Q：Firefox 进程内网关

自动脚本：`node scripts/firefox-gateway-check.mjs`（隔离 profile、`--no-remote`、独立 Marionette 端口 28288、临时加载 `dist-firefox/`）。

- [x] `gecko.id` = `polypage@skymly.com` 与安装器 `DefaultGeckoId` 一致（4.1 回归保持）
- [x] 隔离 profile 临时加载成功（`isActive: true`）
- [x] Options / `host-status`：`installed === true` 且 `protocol === 2`
- [x] 至少一笔 `native-host` 翻译返回（`fx1` 得到中文译文，无 errors）

运行记录（摘要，不含密钥）：

```
ADDON "polypage@skymly.com"
host-status: installed=true protocol=2 browser=firefox
translate.results.fx1: 你好，来自 Firefox 网关检查。
FIREFOX GATEWAY CHECK: connectNative ping + translate OK
```

备注：本机已安装的网关 exe 当时仍回报 `version=4.1.0`；仓库源码 `GatewayServer.Version` 已升为 `4.2.0`，重新 `dotnet publish` + `--install` 后即显示新版本。协议保持 2。

## 4. 支柱 R：流式 / 覆盖 / 版面

- [x] `transcribeStream` 仅在 Provider 实现该方法且 `asr.streaming === true` 时注入 `wt:asr-partial`；否则与 4.1 一次转写完全一致
- [x] 图片原位覆盖：滚动 / resize / visualViewport 后按 `getBoundingClientRect` rAF 合批重算；`wt:restore` 与关开关卸层
- [x] PDF 表格夹具：`layoutPreset=table` 时表头单元格不与左右栏串段（`cellBreak`）

## 5. 真实 Whisper

本机 **无** Whisper 权重。非 4.2 P0 退出条件。保持「待手动 / 无权重」。

## 6. 遗留（可顺延 4.3）

- 表格聚类完美化 / 复杂双栏海报
- 纯 `<audio>` 字幕条
- SRT 导出
- 真实 Whisper 无权重

## 7. 收口后记（2026-08-20）

未提交的 4.2 Options / 覆盖 / 冒烟 / Firefox 脚本与规划文档收入 git。
同期 architecture 加深（翻译管线 / OCR 往返 / 网页翻译 / 转写并翻译 / capability）
把 `npm run test` 扩到 **255**。4.2 退出条件仍以 §1–§4 为准。
