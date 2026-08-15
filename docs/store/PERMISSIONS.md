# PolyPage 权限说明（与 `public/manifest.json` 一致）

版本：4.0.0　日期：2026-08-15

对照 `public/manifest.json`。**无新增必选权限；不申请麦克风。**

## 必选权限

| 权限 | 用途 |
|---|---|
| `storage` | 保存用户设置、翻译缓存、错误/反馈日志。不含开发者遥测。 |
| `nativeMessaging` | 可选连接本机 PolyPage 网关（JSON-RPC）。未安装网关时功能走云端 Provider 或置灰。 |
| `contextMenus` | 右键：翻译选区、翻译图片、转写并翻译无字幕视频/音频。 |

## 主机权限

| 权限 | 用途 |
|---|---|
| `<all_urls>` | 在 http(s) 页面注入内容脚本；同源采集媒体 / 读取图片；向用户配置的任意 API 基址发翻译与转写请求。 |

## 可选权限

| 权限 | 用途 |
|---|---|
| `webNavigation` | 仅当用户在 Options 打开「自动用阅读器打开 PDF」时请求。未授予则开关无效，其它功能不受影响。 |

## 明确不申请

| 权限 | 原因 |
|---|---|
| 麦克风 | ASR 只从已有媒体元素 `captureStream`（或同源 `src` fetch），不录制环境声 |
| `tabCapture` | 不捕获标签页混音 |
| `offscreen` | 4.0 不使用 Chrome-only offscreen 文档 |
| `identity` / `sidePanel` | 无账号、无侧栏 |

Firefox 包（`dist-firefox/`）只增加 `browser_specific_settings.gecko.id`，**不增加权限面**。
