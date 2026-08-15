# PolyPage 4.0 验证记录

日期：2026-08-15　环境：Windows、Node v24.18.0、.NET SDK（网关 net8.0）、
Edge headless（`--headless=new`）、pdfjs-dist 4.10.38 + tesseract.js 7.0.0
（vendor 本地打包，构建期 SHA-256 校验）。

对照 `PolyPage-4.0.md` §11 里程碑退出标准与 §12 验收要求。

---

## 1. 回归门槛（§12.4）

| 项 | 3.0 基线 | 4.0 结果 |
|---|---|---|
| strict TypeScript | 0 错误 | **0 错误** |
| 单元测试 | 163 通过 | **187 通过**（3.0 保留 + 4.0 新增） |
| 冒烟断言 | 103 通过 | **111 通过**（3.0 保留 + ASR / 扫描页按钮等） |
| 网关 xunit | 28 通过 | **32 通过**（只增不减） |
| 网关真实进程 stdio | 9 通过 | 旧项保留；ping `protocol === 2`；新增分块 / `translate.image` |

验证命令（仓库根目录，均已跑过）：

```
npx tsc --noEmit
npx vitest run
node scripts/build.mjs
dotnet test native-host/PolyPage.slnx -v q
node scripts/gateway-contract-test.mjs
npm run smoke
```

## 2. 单元测试（§12.1）

3.0 文件全部保留。4.0 新增 / 扩展：

- `tests/migration4.test.ts`：v3→v4 只补默认；v4 可被旧式归一化安全读取
- `tests/subtitleStyle.test.ts`：swap / position 应用到 DOM
- `tests/tesseract.test.ts`：WASM 桩上 `recognize()` 只填 text，译文走 `translateTexts`
- `tests/scannedOcr.test.ts`：缓存键 = 指纹+页+图像哈希+引擎
- `tests/asr-segment.test.ts`：backend segments / 纯文本均分 / >80 字再切 / 空段丢弃
- `tests/native-chunk.test.ts`：512KiB 切分与 sha256 拼装
- `tests/providers.test.ts`：OpenAI-compatible `transcribe` multipart（非 JSON body）

TM 归一化命中 / 环形淘汰：**未落地**，见 §8。

## 3. 冒烟测试（§12.2）— 111 项全部通过

`npm run smoke`（无头 Edge + mock API + 真实网关）：

- 3.0 用例零回退（六模式、站点规则、划词、SSE、PDF、有 track 视频、图片 OCR、续译、网关 failover）
- schema：v2 载荷经真实 `save-settings` 落盘为 `schemaVersion: 4`，ASR / TM / 扫描页 OCR 默认值齐全
- 有 `<track>` 的 3.0 视频夹具：**不**自动调用 `/audio/transcriptions`
- 无字幕短 video：`wt:transcribe-media` → mock transcribe **恰好一次** → 双语内存 cue → 再次命令关闭零残留
- 扫描 PDF 页：提示含「没有文本层」且有「识别本页」按钮
- PDF 重开：指纹缓存命中，零新增 API 调用

## 4. 网关（协议 v2）

- `GatewayServer.Version = 4.0.0`，`ProtocolVersion = 2`
- 新方法：`binary.chunk` / `translate.image` / `transcribe`（音频必须 transferId）
- capabilities：`supportsVision` / `supportsAsr` / `maxBinaryBytes`
- 旧 xunit + 旧 stdio 项全绿；契约脚本覆盖 >1MB 分块 sha256 与 HttpBackend 上 `translate.image` 的 -32007
- 原始分块上限为 **512 KiB**（768 KiB raw 经 Base64 后恰好 1 MiB，加上 JSON 会撞 Native Messaging 硬顶）
- `WhisperBackend`：HTTP `/v1/audio/transcriptions` 或 command 模板（权重不进仓库）
- 安装器：`--allow-id`、`{HostName}.firefox.json` 的 `allowed_extensions`、HKCU `Software\Mozilla\NativeMessagingHosts`

## 5. 构建与打包

- `scripts/build.mjs`：Chrome/Edge `dist/` + `dist-firefox/`
- `dist-firefox/manifest.json`：`browser_specific_settings.gecko.id = polypage@skymly.com`，background 为 `scripts` 事件页
- vendor：pdf.js + tesseract.js + `tessdata/eng` + `tessdata/chi_sim`，哈希钉在 `scripts/vendor-hashes.json`
- 内容脚本不内嵌 WASM（`content.js` ≈ 63KB）
- 商店材料：`docs/store/{PRIVACY,PERMISSIONS,LISTING}.md`，权限表与 `public/manifest.json` 一致
  （`storage` / `nativeMessaging` / `contextMenus` / `<all_urls>` / 可选 `webNavigation`；无麦克风）

## 6. 里程碑退出标准核对（§11）

- **M7**：v3→v4 迁移 ✔；tesseract 两步法 ✔；扫描页「识别本页」✔；字幕 swap/position/background ✔
- **M8**：协议 v2 + 分块/image/transcribe ✔；openai-compatible.transcribe ✔；无字幕 ASR MVP ✔；有 track 不自动 ASR ✔；WhisperBackend ✔；`<audio>` 入口（右键 / Popup / `pickCaptionlessMedia`）✔
- **M9**：`docs/FIREFOX-MV3.md` + `dist-firefox/` ✔；安装器 Mozilla 键 ✔；商店三份材料 ✔

## 7. 手动联调清单（§12.3）

| 项 | 状态 | 说明 |
|---|---|---|
| 真实 OpenAI-compatible 转写或本地 faster-whisper | 待手动 | 自动侧已用 mock `/audio/transcriptions` 钉住路径 |
| 真实 Ollama 视觉模型经网关 `translate.image` | 待手动 | 需本机视觉模型；契约侧 HttpBackend 返回 -32007 为预期 |
| Firefox 临时加载：Wikipedia 类页面六模式 + 划词 | 待手动 | `about:debugging` 载入 `dist-firefox/`；完整无头冒烟以 Edge 为准 |
| 3.0 老设置升级 4.0 后功能正常 | ✅ 自动覆盖 | 冒烟 v2 载荷 → schema 4；`migration4.test.ts` 读兼容 |

## 8. 遗留（允许顺延 4.1，不得 silently drop）

1. **句子级翻译记忆（TM）**：schema 字段与默认关闭已在 v4；无 `storage/tm.ts` 查表/写入，无 Options 清空按钮
2. **OCR 附加语言包按需下载**：默认只打包 `eng` + `chi_sim`；无 Options 下载器
3. **ASR 流式 cue**：一次转写结束后注入内存 cue，不边转写边出字幕
4. **Firefox 网关真联调**：安装器已写 Mozilla 键与 `allowed_extensions`；未做 Firefox 进程内 Native Messaging 往返
5. **图片原位覆盖**：仍为结果面板，无半透明底 + 译文盖图
6. **PDF 双栏 / 表格聚类专项**：3.0 启发式保留，无按文档类型可调参数专项

其它备注：

- 4.0 不导出 SRT/VTT；ASR 关闭即丢内存 cue
- `protocol=1` 旧网关：扩展侧按 capabilities 置灰 ASR / 网关视觉，不抛错
- 音频元素可走同一转写管线；自绘层目前挂在 `HTMLVideoElement` 上，纯 `<audio>` 不画字幕条
