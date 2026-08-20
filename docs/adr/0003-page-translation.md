# NodeEntry 不是网页翻译的 interface

网页翻译的测试曾经直接构造 NodeEntry 再调 renderer。那会让 12 个可变字段留在 seam 上，收回只是换 import。

NodeEntry 留在内部。测试和内容脚本 bootstrap 都走 scan / translate / restore / setMode。翻译通过注入的 translateItems 进入，chrome.runtime 只是其中一个 adapter。
