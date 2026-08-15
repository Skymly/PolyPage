# PolyPage 隐私政策（商店材料草稿）

版本：4.0.0　日期：2026-08-15

本文是 Chrome Web Store 提交用草稿，不是已上架声明。

## 我们收集什么

PolyPage **不运营账号、不同步云端配置、不把页面内容发到开发者服务器**。

扩展会处理的数据只在用户本机或用户**自己配置**的翻译 / 转写端点之间流动：

1. **网页文本、选区、字幕 cue、PDF 段落、图片字节、无字幕媒体的音轨窗口**  
   仅在用户触发翻译 / OCR / 转写后，发往当前启用的 Provider（OpenAI 兼容端点、DeepL、Azure、Google、或本机网关）。
2. **设置与缓存**  
   存在浏览器 `chrome.storage`（本机）。API Key 只出现在后台与本机网关，内容脚本与 Popup 不持有密钥。
3. **可选本机网关**  
   若用户安装 Native Messaging 网关，音频 / 图片经本机进程转发到用户配置的后端（Ollama、whisper.cpp、HTTP Whisper 等）。网关不内嵌、不分发模型权重。

## 我们不收集

- 不申请麦克风、`tabCapture`、`offscreen`
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
