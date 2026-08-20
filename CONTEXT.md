# PolyPage

A browser extension that turns webpage, PDF, image, and media source text into translations the user can read in place.

## Language

**翻译管线**:
The one module that turns source text into a translation, including cache, sentence TM, output hygiene, Provider failover, and Provider stats.
_Avoid_: 后台翻译, 统一翻译, 翻译队列

**译文**:
The translation after output hygiene. This is what callers, cache, and sentence TM see. Streaming deltas are not 译文.
_Avoid_: 把流式 delta 叫做译文

**OCR 往返**:
The one module that turns an image into ordered segments of source text plus optional translation. Vision one-step is not 翻译管线; tesseract two-step sends recognized sentences through 翻译管线. A segment may have source and no translation (OCR-only, or hygiene stripped a vision fragment).
_Avoid_: 图片翻译, 识图管线, OCR engine（engine 只是往返内部的 adapter）

**Provider**:
A user-configured backend that produces translations, and may also do vision or transcription.
_Avoid_: service, API, engine

**续译**:
Restoring in-flight webpage or PDF node translations after the background restarts.
_Avoid_: 用续译指字幕 cue 或流式条目

**探活**:
Checking that a Provider answers. Not a translation.
_Avoid_: 测试翻译, test translation
