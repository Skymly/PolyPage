# YouTube 实站字幕验证

在 Windows 上使用 Edge 158.0.4370.33 和独立浏览器配置。原视频和原字幕由 YouTube 播放器提供，测试译文由回环 HTTP 服务返回。回环服务使用固定规则返回中文测试文字，每一条导出译文都可与浏览器实际提交的原文核对。

## 定位

- **播放器没有交付原字幕。** 关闭扩展，W3C 的 48 秒短片可以播到结尾，点击原生 CC 后由播放器发出的英文字幕请求返回 HTTP 200，但正文为 0 字节，播放过程中也没有字幕节点。W3C 合辑在窗口版和无头 Edge 均有空字幕响应，3Blue1Brown 的影片在无头 Edge 也返回空响应。这些样本没有可交给 PolyPage 的原文。[W3C 短片](https://www.youtube.com/watch?v=iWO5N3n1DXU) · [W3C 合辑](https://www.youtube.com/watch?v=3f31oufqFSM) · [3Blue1Brown 影片](https://www.youtube.com/watch?v=aircAruvnKk)
- **播放器有字幕，扩展缺少入口。** 华盛顿大学的公开影片由宿主页提供播放和选择字幕的按钮，原字幕节点实际出现在 `www.youtube-nocookie.com` 的 YouTube iframe。旧默认规则只匹配 `*.youtube.com`。即使手动配置 iframe 的站点规则，旧弹窗也只查看顶层页面，检测不到子 frame 里的字幕，开关和导出不会发给播放器所在的 frame。用旧构建复现了后一个问题，本机嵌入播放器字幕已有译文，打开弹窗仍没有字幕开关。修复后同一夹具可从弹窗下载 SRT 并关闭翻译。[公开嵌入演示](https://ableplayer.github.io/ableplayer/demos/youtube3.html) · [原视频](https://www.youtube.com/watch?v=EcFzdNEkqok)

扩展更新了默认 YouTube 规则，保留已保存规则的启用状态和字幕选择器。弹窗按现有 frame 列表获取最新播放器状态，字幕开关和 SRT 请求发往同一个已检测到的播放器 frame。顶层有可用字幕时仍优先使用顶层播放器。

第一次实际下载还发现，YouTube 将切轨时的语言名和齿轮提示放在带 `.ytp-caption-segment` 的顶部提示框中，旧采样器会提交这两行文字并写入 SRT。现在按齿轮图标的 DOM 结构排除整个提示框。浏览器回归同时验证，真正放在画面上方的字幕仍然进入翻译和导出。

## 同一公开视频的最终验收

2026 年 11 月 24 日，使用 `DO-IT Scholar Profile: K` 的公开嵌入播放页完成以下操作。宿主页上的字幕菜单控制 YouTube iframe 内的官方影片和字幕轨。[实测播放页](https://ableplayer.github.io/ableplayer/demos/youtube3.html) · [YouTube 视频](https://www.youtube.com/watch?v=EcFzdNEkqok)

| 操作 | Edge 实测结果 |
| --- | --- |
| 从字幕菜单手选 English，再选 Spanish | iframe 中英文原文为 `[music]`，切到西语后显示 `(Música)`，两条均与各自的测试译文匹配。 |
| 点击播放进度条 | 播放时钟从 4.576 秒跳到 70.363 秒，原文更新为 `DO-IT me presentó a mis tutores`，并显示对应译文。 |
| 使用播放器按钮进入全屏 | 浏览器的全屏容器包含 YouTube iframe，同一句西语台词及其译文都可见。 |
| 从 PolyPage 弹窗点「导出已译字幕 (.srt)」 | 实际下载 340 字节、4 条字幕，UTF-8 BOM、CRLF、连续编号、按时间排序。两行跳转后的字幕区间为 `00:01:10,423 --> 00:01:10,847`。每条均对应播放器实际显示的原文，文件中没有 `Spanish` 或齿轮提示。 |
| 点「关闭字幕翻译」 | 暂停时核对了同一句西语原文，关闭后原文仍在，所有 PolyPage 字幕属性均已移除。 |

该 SRT 的 SHA-256 为 `cd47d44e1938a4f6a2ff8c02714d49beebd7e19229377f5cb915d562769d6f60`。自绘字幕时间取自浏览器实际观测的播放区间。此次快速切换和跳播只采到了西语音乐提示的短片段，导出包含这场播放已译的英、西语片段。另有试次收到了非空英文响应但没有出现字幕节点，最终验收以上述实际可见的片段为准。

## YouTube 播放页补测

2026 年 11 月 22 日的 ABC News Live 可直接在 YouTube 播放页手动开启英语字幕。Edge 内确认没有标准 `TextTrack`，英文原文由 YouTube 自绘播放器渲染。加载扩展后，验证了浏览器播放器全屏、PolyPage 开关、恢复相同的原字幕文本与 HTML，以及从弹窗实际下载 SRT。记录中的 SRT 有 6 条，466 字节，含 UTF-8 BOM、按时间排序的连续编号和双语内容。该场直播菜单只提供「关闭」与「英语」，另用上面的 YouTube 嵌入视频验证英、西两轨。直播回看在这一轮没有完成字幕到达断言。[当日直播](https://www.youtube.com/watch?v=QbWsfPZrRpA) · [ABC News 直播入口](https://www.youtube.com/@ABCNews/live)

### 2026 年 11 月 24 日，普通 `youtube.com/watch` 播放页

在未加载 PolyPage 的独立 Edge 158.0.4370.33 中打开普通播放页，先检查播放器是否交付原字幕。三个候选的页面和标题均加载，播放时钟保持在 0 秒，播放器没有进入可播放状态，也没有字幕节点。[DO-IT Scholar Profile: K](https://www.youtube.com/watch?v=EcFzdNEkqok) · [Sintel](https://www.youtube.com/watch?v=HomAZcKm3Jo) · [W3C 字幕短片](https://www.youtube.com/watch?v=iWO5N3n1DXU)

对 DO-IT 再做一次独立探测，页面明确显示 “Sign in to confirm you’re not a bot”，播放器状态为 `LOGIN_REQUIRED`，`readyState` 始终为 0。这条登录提示也出现在完全未加载扩展的配置中。这轮没有在普通播放页取得两条原字幕，切轨、跳播、全屏、SRT 下载和关闭恢复均未验收。随后尝试查看窗口版 Edge 时，桌面控制工具无法可靠核实当前 URL，终止了桌面操作。上面的嵌入播放器结果与本轮普通播放页结果分别记录。

## 复测命令

```powershell
npm run typecheck
npm test -- --maxWorkers=6
npm run build
node scripts/media-browser-check.mjs
node scripts/youtube-subtitles-check.mjs --self-test
$env:PLAYWRIGHT_MODULE = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js'
node scripts/youtube-embed-check.mjs --keep-srt "$env:TEMP/polypage-youtube-embed-nov24.srt"
```

已能通过 Node 找到 Playwright 的环境可省略 `PLAYWRIGHT_MODULE`。导出文件使用独立的新路径，避免覆盖已有样例。

最终构建通过类型检查、91 个测试文件的 572 项测试，以及 Edge 媒体专项和 143 项端到端冒烟断言。
