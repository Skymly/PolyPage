# Firefox MV3 差异表（PolyPage 4.0）

对照 `PolyPage-4.0.md` §8.2。Chrome / Edge 继续加载 `dist/`；Firefox 临时加载
`dist-firefox/`（`browser_specific_settings.gecko.id = polypage@skymly.com`）。

4.0 退出标准是：**临时加载不报 manifest 错误** + 网页六模式与划词可用。
Native Host / PDF / ASR 允许降级。完整无头冒烟仍以 Edge 为准。

## 1. API 差异

| 主题 | Chrome / Edge（发行主线） | Firefox MV3 MVP | 4.0 策略 |
|---|---|---|---|
| 命名空间 | `chrome.*` | `browser.*` 与 `chrome.*` 别名 | 代码只写 `chrome.*`，不引入 `browser` polyfill |
| Background | `background.service_worker` + `type: module` | 121+ 支持 SW；更稳妥用 `background.scripts` 事件页 | `dist/` 保持 SW；`dist-firefox/` 写成 `scripts: ["background.js"]` + `type: module` |
| Action | `action`（MV3） | 同 MV3 `action`；无 `browserAction` | 只用 `action` |
| Content scripts | `all_frames: true` | 同左 | 保持；顶层 host 黑名单对 iframe 生效 |
| Commands | `commands.suggested_key` | 支持，部分组合需用户在 about:addons 确认 | 保持 `Ctrl+Shift+L` / `Alt+Q` |
| Native Messaging | `allowed_origins` + HKCU Chrome/Edge 键 | `allowed_extensions: ["<gecko.id>"]` + `Software\Mozilla\NativeMessagingHosts` | 安装器已写 Firefox manifest 与 Mozilla 键；**真联调顺延 4.1** |
| `chrome.runtime.getURL` | 阅读器 / vendor WASM | 同左；worker 路径偶发差异 | PDF 入口在失败时隐藏；见 Options「浏览器兼容」 |
| `webNavigation` | optional_permissions | 权限模型不同，默认关 | 保持可选；未授权则不自动打开 PDF |
| `captureStream` / `MediaRecorder` | Chromium mime（webm/opus） | `mozCaptureStream` + mime 分裂 | 已做 mime 回退；失败则同源 `fetch(src)`；再失败入口置灰 |
| `chrome.offscreen` / `sidePanel` / `identity` | Chrome-only | 不存在 | **4.0 不使用** |
| `tabCapture` / 麦克风 | 可申请 | 可申请 | **不申请**；ASR 只用元素 `captureStream` |

## 2. 能力降级

| 能力 | 降级 |
|---|---|
| Native Host | 未注册 Mozilla 键或 `connectNative` 失败 → 视为未安装，走 failover |
| PDF 阅读器 | worker / `getURL` 失败时入口隐藏，不抛未捕获异常 |
| ASR | 无 `captureStream` / 无可用 mime / 无音轨且无法 fetch → 返回错误，Popup 置灰 |
| 网关视觉 / ASR | `protocol < 2` 或 capabilities 缺字段 → 入口置灰 |

## 3. 加载步骤（手动）

1. `npm run build`（同时产出 `dist/` 与 `dist-firefox/`）
2. Firefox `about:debugging` → 此 Firefox → 临时载入附加组件 → 选 `dist-firefox/manifest.json`
3. 打开任意 http(s) 页面，验证六模式与划词
4. Native Host / PDF / ASR 若置灰，对照上表，不要当作崩溃

固定扩展 ID：`polypage@skymly.com`（供日后 Native Messaging `allowed_extensions`）。
