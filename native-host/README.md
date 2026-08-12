# PolyPage Gateway（本地 Native Messaging Host）

2.0 支柱 A 的本地网关：C#/.NET 8 控制台程序，作为浏览器 Native Messaging
Host 运行，把扩展的翻译请求路由到本地或远程后端（Ollama、企业内网 HTTP 服务
等）。**网关是可选依赖**——未安装网关时，扩展功能与 1.0 完全等价。

## 架构

```text
扩展 Background (MV3 SW)  ──Native Messaging(stdio, 长度前缀 JSON)──▶  PolyPage Gateway
     native-host Provider        JSON-RPC 2.0                          后端路由
                                                                          ├─ OllamaBackend (localhost:11434/v1)
                                                                          └─ HttpBackend   (通用 JSON 转发)
```

- 传输层：Native Messaging 标准帧（32 位小端长度前缀 + UTF-8 JSON，单条 ≤ 1MB）。
- 应用层：JSON-RPC 2.0，方法见下表。
- 凭据只存在网关本机（`gateway.json`，敏感字段 Windows DPAPI 加密），浏览器侧零接触。

## JSON-RPC 方法

| 方法 | 说明 |
|---|---|
| `ping` | 探活，返回 `{ protocol, name, version }` |
| `capabilities` | 后端列表、是否支持流式、批量上限 |
| `translate` | 批量翻译 `{ texts[], source, target, backend? }` → `{ translations[], backend }` |
| `translate.stream` | 单条流式 `{ text, source, target, backend? }`；逐块 `translate.delta` 通知 + 最终 `{ translation }` |
| `cancel` | 按请求 id 取消 |
| `backends.list` | 后端元数据 |
| `health` | 各后端健康状态 |

错误码沿用扩展 ErrorKind 语义：`-32001` network / `-32002` timeout /
`-32003` auth / `-32004` rate_limit / `-32005` server / `-32006`
invalid_response / `-32007` config。

## 构建与发布

```powershell
dotnet build native-host/PolyPage.slnx            # 开发构建
dotnet test  native-host/PolyPage.slnx            # 协议契约测试（帧编解码/路由/后端）
dotnet publish native-host/PolyPage.Gateway -c Release -r win-x64
# 产物：native-host/PolyPage.Gateway/bin/Release/net8.0/win-x64/publish/PolyPage.Gateway.exe
#（PublishSingleFile + SelfContained，单文件 x64）
```

## 安装（Windows，无需管理员）

```powershell
# 开发态：先加载扩展拿到扩展 ID（chrome://extensions），再追加 allowed_origins
.\PolyPage.Gateway.exe --install --allow "chrome-extension://<扩展ID>/"

# 查询安装状态
.\PolyPage.Gateway.exe --status

# 卸载（移除注册表项与文件；保留 gateway.json 配置与日志）
.\PolyPage.Gateway.exe --uninstall
```

安装器职责：

1. 复制网关到 `%LocalAppData%\PolyPage\PolyPage.Gateway.exe`；
2. 生成 host manifest（`%LocalAppData%\PolyPage\com.skymly.polypage.gateway.json`）；
3. 写入 HKCU 注册表（Chrome + Edge 的 `NativeMessagingHosts`）。

重复执行 `--install --allow ...` 会向 `allowed_origins` 追加新来源。

## 配置（`%LocalAppData%\PolyPage\gateway.json`）

首次运行自动生成。示例：

```json
{
  "defaultBackend": "ollama",
  "ollama": [
    {
      "id": "ollama",
      "name": "Ollama (local)",
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5:7b",
      "apiKey": "",
      "timeoutMs": 180000
    }
  ],
  "http": [
    {
      "id": "corp-http",
      "name": "企业内网翻译服务",
      "url": "http://intranet.example.com/api/translate",
      "method": "POST",
      "bodyTemplate": "{ \"q\": {{texts}}, \"from\": \"{{sourceLanguage}}\", \"to\": \"{{targetLanguage}}\" }",
      "responsePath": "data.translations",
      "apiKey": "（保存后自动 DPAPI 加密为 $enc: 前缀）",
      "headers": {},
      "timeoutMs": 60000
    }
  ]
}
```

- `ollama[].model` 留空时自动取 `/api/tags` 的第一个模型。
- `apiKey` 等敏感字段在网关写回配置时自动 DPAPI 加密（CurrentUser 作用域）。
- 环境变量 `POLYPAGE_GATEWAY_CONFIG` 可覆盖配置文件路径（测试用）。

扩展侧 Provider 配置：类型选 `native-host`，`hostName` 默认
`com.skymly.polypage.gateway`，`backend` 填后端 id（如 `ollama` 或
`corp-http`，留空用 `defaultBackend`），并可指定网关不可用时的回退 Provider。

## 日志

`%LocalAppData%\PolyPage\logs\gateway-yyyyMMdd.log`，滚动保留 7 天。

## 契约测试

- `PolyPage.Gateway.Tests`：帧编解码（含 1MB 边界）、JSON-RPC 路由、批量上限、
  错误码映射、流式通知、HttpBackend 报文构造/解析（对内置 HttpListener 桩）。
- `scripts/gateway-contract-test.mjs`：启动真实发布的网关进程，经真实 stdio
  帧跑完整协议（Node 仿真扩展侧）。
- `scripts/gateway-ollama-check.mjs`：经网关调用真实本地 Ollama 模型联调。

## 已知限制

1. 安装器目前仅 Windows（注册表模型为 Windows 特有；Linux/macOS 清单路径不同，
   按 2.0 非目标延后）。
2. 网关→扩展方向单帧 1MB 上限：超大批量必须由扩展侧按 `maxBatchChars`
   预切分（网关会返回 `-32007` 提示，不做二次拆分）。
3. qwen3 等带思考模式的模型流式输出可能包含 `</think>` 片段（模型行为，
   可选用 `/no_think` 类提示或不带思考的模型规避）。