using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace PolyPage.Gateway.Backends;

/// <summary>Configuration for the Ollama (OpenAI-compatible) backend.</summary>
public sealed class OllamaBackendConfig
{
    public string Id { get; set; } = "ollama";
    public string Name { get; set; } = "Ollama (local)";
    public string BaseUrl { get; set; } = "http://localhost:11434";
    /// <summary>Model name; empty means "first model reported by /api/tags".</summary>
    public string Model { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public int TimeoutMs { get; set; } = 180000;
}

/// <summary>
/// Ollama backend (spec 2.0 §5.4 item 4): calls the OpenAI-compatible
/// /v1/chat/completions endpoint of a locally running Ollama server.
/// Supports SSE streaming.
/// </summary>
public sealed class OllamaBackend : IGatewayBackend
{
    private static readonly HttpClient Http = new() { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

    private readonly OllamaBackendConfig _config;

    public OllamaBackend(OllamaBackendConfig config) => _config = config;

    public string Id => _config.Id;
    public string Name => _config.Name;
    public string Kind => "ollama";
    public BackendCapabilities Capabilities => new(SupportsStreaming: true, MaxBatchItems: 10, MaxBatchChars: 6000);

    public async Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
    {
        if (texts.Count == 0) return Array.Empty<string>();
        var userContent = BuildBatchPrompt(texts, ctx);
        var reply = await ChatAsync(userContent, stream: false, onDelta: null, ct: ct);
        var parsed = TemplateHelper.ParseBatchTranslation(reply, texts.Count);
        if (parsed is null)
        {
            // Retry item-by-item for robustness with smaller local models.
            if (texts.Count <= 6)
            {
                var single = new List<string>();
                foreach (var text in texts)
                {
                    var one = await ChatAsync(BuildSinglePrompt(text, ctx), stream: false, onDelta: null, ct: ct);
                    single.Add(one.Trim());
                }
                return single.ToArray();
            }
            throw new GatewayBackendException(RpcCodes.InvalidResponse,
                $"Ollama 批量结果无法解析（期望 {texts.Count} 条）");
        }
        return parsed;
    }

    public IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct)
    {
        return ChatStreamAsync(BuildSinglePrompt(text, ctx), ct);
    }

    public async Task<BackendHealth> ProbeAsync(CancellationToken ct)
    {
        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(3000);
            var url = $"{_config.BaseUrl.TrimEnd('/')}/api/tags";
            using var res = await Http.GetAsync(url, timeoutCts.Token);
            return res.IsSuccessStatusCode
                ? new BackendHealth(true, $"Ollama 在线 ({_config.BaseUrl})")
                : new BackendHealth(false, $"Ollama 返回 HTTP {(int)res.StatusCode}");
        }
        catch (Exception e)
        {
            return new BackendHealth(false, $"无法连接 Ollama：{e.Message}");
        }
    }

    /* --------------------------------- helpers --------------------------------- */

    private static string BuildSinglePrompt(string text, TranslateContext ctx) =>
        $"Translate the following text from {ctx.Source} to {ctx.Target}. Output ONLY the translation:\n\n{text}";

    private static string BuildBatchPrompt(IReadOnlyList<string> texts, TranslateContext ctx)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Translate the following {texts.Count} texts from {ctx.Source} to {ctx.Target}.");
        sb.AppendLine($"Return ONLY a JSON array of exactly {texts.Count} translated strings, in the same order. Do not output anything else.");
        sb.AppendLine();
        for (var i = 0; i < texts.Count; i++) sb.AppendLine($"{i + 1}) {texts[i]}");
        return sb.ToString();
    }

    private async Task<string> ResolveModelAsync(CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_config.Model)) return _config.Model;
        try
        {
            var url = $"{_config.BaseUrl.TrimEnd('/')}/api/tags";
            using var res = await Http.GetAsync(url, ct);
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
                var first = doc.RootElement.GetProperty("models")[0].GetProperty("name").GetString();
                if (!string.IsNullOrWhiteSpace(first)) return first;
            }
        }
        catch
        {
            // fall through to config error
        }
        throw new GatewayBackendException(RpcCodes.Config,
            "Ollama 未配置模型且无法自动检测（请确认 Ollama 已运行并在 gateway.json 中配置 model）");
    }

    private HttpRequestMessage BuildRequest(string userContent, bool stream)
    {
        var url = $"{_config.BaseUrl.TrimEnd('/')}/v1/chat/completions";
        var body = new Dictionary<string, object?>
        {
            ["model"] = _config.Model,
            ["stream"] = stream,
            ["temperature"] = 0.2,
            ["messages"] = new object[]
            {
                new Dictionary<string, string>
                {
                    ["role"] = "system",
                    ["content"] = "You are a professional translation engine. Output ONLY translations.",
                },
                new Dictionary<string, string> { ["role"] = "user", ["content"] = userContent },
            },
        };
        var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(body),
        };
        if (!string.IsNullOrWhiteSpace(_config.ApiKey))
        {
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_config.ApiKey}");
        }
        return req;
    }

    private async Task<string> ChatAsync(string userContent, bool stream, Action<string>? onDelta, CancellationToken ct)
    {
        var model = await ResolveModelAsync(ct);
        if (string.IsNullOrEmpty(_config.Model)) _config.Model = model;
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(_config.TimeoutMs);
        try
        {
            using var req = BuildRequest(userContent, stream);
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
            if (!res.IsSuccessStatusCode)
            {
                throw new GatewayBackendException(ClassifyStatus((int)res.StatusCode),
                    $"Ollama 请求失败 (HTTP {(int)res.StatusCode})");
            }
            var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync(timeoutCts.Token));
            var content = json.RootElement
                .GetProperty("choices")[0]
                .GetProperty("message")
                .GetProperty("content")
                .GetString();
            if (string.IsNullOrWhiteSpace(content))
            {
                throw new GatewayBackendException(RpcCodes.InvalidResponse, "Ollama 返回了空内容");
            }
            return content;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new GatewayBackendException(RpcCodes.Timeout, $"Ollama 请求超时（{_config.TimeoutMs}ms）");
        }
        catch (HttpRequestException e)
        {
            throw new GatewayBackendException(RpcCodes.Network, $"无法连接 Ollama：{e.Message}", e);
        }
    }

    private async IAsyncEnumerable<string> ChatStreamAsync(string userContent, [EnumeratorCancellation] CancellationToken ct)
    {
        var model = await ResolveModelAsync(ct);
        if (string.IsNullOrEmpty(_config.Model)) _config.Model = model;
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(_config.TimeoutMs);
        HttpResponseMessage res;
        try
        {
            var req = BuildRequest(userContent, stream: true);
            res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new GatewayBackendException(RpcCodes.Timeout, $"Ollama 请求超时（{_config.TimeoutMs}ms）");
        }
        catch (HttpRequestException e)
        {
            throw new GatewayBackendException(RpcCodes.Network, $"无法连接 Ollama：{e.Message}", e);
        }
        using (res)
        {
            if (!res.IsSuccessStatusCode)
            {
                throw new GatewayBackendException(ClassifyStatus((int)res.StatusCode),
                    $"Ollama 请求失败 (HTTP {(int)res.StatusCode})");
            }
            using var reader = new StreamReader(res.Content.ReadAsStream(timeoutCts.Token), Encoding.UTF8);
            while (!reader.EndOfStream)
            {
                ct.ThrowIfCancellationRequested();
                var line = await reader.ReadLineAsync(ct);
                if (line is null || !line.StartsWith("data:")) continue;
                var data = line[5..].Trim();
                if (data == "[DONE]") break;
                string? delta;
                try
                {
                    using var doc = JsonDocument.Parse(data);
                    delta = doc.RootElement.GetProperty("choices")[0]
                        .GetProperty("delta").GetProperty("content").GetString();
                }
                catch (Exception)
                {
                    continue;
                }
                if (!string.IsNullOrEmpty(delta)) yield return delta;
            }
        }
    }

    private static int ClassifyStatus(int status) => status switch
    {
        401 or 403 => RpcCodes.Auth,
        429 => RpcCodes.RateLimit,
        >= 500 => RpcCodes.Server,
        _ => RpcCodes.Config,
    };
}