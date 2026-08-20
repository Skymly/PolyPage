# OCR 往返结果不是译文

OCR 段列表曾经塞进翻译管线 cache，用 `img:hash|engine` 冒充一句原文。翻译管线 cache 的对象是**译文**；把整页 JSON 放进去是 leakage，换引擎 / 仅识别 / glossary 失效方式都会缠在一起。

OCR 往返自备 cache。视觉一步不走翻译管线、不做 failover。tesseract 二步只把识别出的句子交给翻译管线。
