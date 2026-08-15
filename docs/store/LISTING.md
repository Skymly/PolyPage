# Chrome Web Store Listing 草稿（4.0）

「已上架」不是 4.0 退出条件。下列文案供人工提交。

## 短名称

PolyPage

## 标题（≤75）

PolyPage — Web Translator（网页 / PDF / 图片 / 字幕 / 语音）

## 简短描述（≤132）

用你自己的 LLM 或本地网关翻译网页、PDF、图片和视频字幕；无字幕视频可转写。双语阅读，不改原页。

## 详细描述

PolyPage 是 Manifest V3 网页翻译扩展。翻译服务由你自己配置（OpenAI 兼容、DeepL、Azure、Google，或本机网关），密钥只存在浏览器后台 / 本机，开发者不经手页面内容。

**网页**
- 六种显示模式：双语、对照、译文、悬停看原文、悬停看译文、行内
- 划词翻译、站点规则、黑名单、术语表
- 关闭即还原，不破坏原页 DOM

**PDF / 图片 / 字幕（3.0）**
- 内置双语 PDF 阅读器（本地 pdf.js）
- 图片 OCR：视觉模型或本地 tesseract-wasm（eng + chi_sim）
- 有 `<track>` 的视频：接管并双语渲染，关闭还原

**语音（4.0）**
- 无字幕视频 / 音频：用户点击后从当前播放位置转写有限窗口（默认 90 秒）
- 不申请麦克风；不自动转写整页
- 转写结果是内存字幕，关闭即丢

**本地网关（可选）**
- Native Messaging JSON-RPC：文本翻译、图片、语音分块上传
- Whisper / 视觉模型由用户自装，扩展不分发权重

Chrome 与 Edge 为发行主线。Firefox 提供可临时加载的 MV3 包（见仓库 `docs/FIREFOX-MV3.md`），本轮不上 AMO。

## 分类建议

Productivity / Tools

## 截图说明（需另配图）

1. Popup：六模式 + 翻译/恢复
2. 双语网页（Wikipedia 类）
3. PDF 阅读器段落对照
4. 图片 OCR 结果面板
5. 视频双语字幕层
6. Options：Provider 与 ASR 窗口设置

## 宣传图文案

Your model. Your page. Nothing rewritten.

## 隐私 / 单一用途声明（CWS 问卷摘要）

- 单一用途：用户触发的网页翻译与相关内容（PDF / 图片 / 字幕 / 语音转写）
- 远程代码：无。tesseract WASM 与语言包均本地打包
- 用户数据：不出售；只发往用户配置的端点
