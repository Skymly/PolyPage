# 翻译管线是唯一的原文→译文 module

Cue 与 stream 曾经各写一份 cache / TM / sanitize / failover，看起来像是为字幕低延迟做的分流。那会让「同一句在网页走 failover、在字幕不走」成为一种会复发的缺陷。

决定抽出 in-process **翻译管线**：网页、PDF、划词、字幕 cue、流式、OCR 二步穿过同一 interface。`immediate` 只跳过 80ms 合并窗。chrome.runtime 上的 `translate` / `translate-cue` / stream port 留作 adapter，不把消息协议收进这一刀。

探活不是翻译，不走管线。视觉一步也不走管线。
