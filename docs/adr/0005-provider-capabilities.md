# 内容脚本不按 Provider 类型名分支

内容脚本曾用 `providerType === 'openai-compatible'` 猜测能否流式。native-host 同样实现 translateStream，能力在类型名上泄漏过内容/后台 seam。

能力投影留在 Provider 侧。内容脚本只收 boolean。Options 按类型显隐表单仍是配置 adapter，不是这条泄漏。
