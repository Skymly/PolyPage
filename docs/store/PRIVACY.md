# PolyPage 隐私政策（商店材料草稿）

版本：4.2.1　日期：2026-11-21

本文是 Chrome Web Store 提交用草稿，不是已上架声明。

## 我们收集什么

PolyPage **不运营账号、不同步云端配置、不把页面内容发到开发者服务器**。

扩展会处理的数据只在用户本机或用户**自己配置**的翻译 / 转写端点之间流动：

1. **网页文本、选区、字幕 cue、PDF 段落、图片字节、无字幕媒体的音轨窗口**  
   仅在用户触发翻译 / OCR / 转写后，发往当前启用的 Provider（OpenAI 兼容端点、DeepL、Azure、Google、或本机网关）。
2. **设置与缓存**  
   存在浏览器 `chrome.storage`（本机）。API Key 明文存在扩展后台存储，不出现在内容脚本、Popup 或 PDF 阅读器。Options 导出 JSON 默认抹掉 `apiKey` 与自定义 `headers`。
3. **可选本机网关**  
   若用户安装 Native Messaging 网关，音频 / 图片经本机进程转发到用户配置的后端（Ollama、whisper.cpp、HTTP Whisper 等）。网关不内嵌、不分发模型权重。
4. **模型列表与订阅额度**。获取模型列表时，扩展向所选服务的模型目录发送请求，并按接口要求使用该服务的 API Key。手动或定期查询 OpenCode Go 额度时，个人 API Key 发给 OpenCode Go 的额度接口，查询结果保存在本机。

## 我们不收集

- 不申请麦克风、`tabCapture`
- `offscreen` 仅用于 Chrome/Edge 本地 Tesseract OCR（在后台页里跑 Worker）；图片不离开本机，除非用户选用云端视觉引擎
- 不自动转写整页视频或整段播客
- 不上传浏览历史到开发者
- 不出售或与广告网络共享数据
- ASR 内存字幕关闭即丢弃；4.0 不导出 SRT/VTT

## 权限对应的数据使用

见同目录 `PERMISSIONS.md`。每一项必选权限都有单一、可陈述的用途。

## 第三方

用户在 Options 填写的 API 基址与密钥决定数据发往何处。开发者无法看到这些请求。请阅读对应用户所选服务的隐私政策。

## 联系

仓库：https://github.com/Skymly/PolyPage
