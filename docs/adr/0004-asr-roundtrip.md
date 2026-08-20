# 转写并翻译一次返回带译文的 cue

「转写并翻译」曾拆成 SW 转写（translation 恒为空）加内容脚本逐条 translate-cue。缺陷出现在两段怎么接上，而不是 segmentTranscript。

转写并翻译 module 在后台完成转写，再把句子交给翻译管线。增量 partial 只是原文进度。采集仍在页内。ASR 内存 cue 不再 translate-cue；有 track 的字幕仍走 cue。
