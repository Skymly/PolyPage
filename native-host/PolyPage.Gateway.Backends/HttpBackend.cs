using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace PolyPage.Gateway.Backends;

/// <summary>Configuration for the generic HTTP JSON backend.</summary>
public sealed class HttpBackendConfig
{
    public string Id { get; set; } = "corp-http";
    public string Name { get; set; } = "Corporate HTTP gateway";
    public string Url { get; set; } = "";
    public string Method { get; set; } = "POST";
    /// <summary>JSON body template with {{texts}}/{{text}}/{{sourceLanguage}}/{{targetLanguage}}/{{apiKey}}.</summary>
    public string BodyTemplate { get; set; } = "";
    /// <summary>Dot path into the JSON response holding the translations.</summary>
    public string ResponsePath { get; set; } = "";
    /// <summary>Sensitive: DPAPI-encrypted at rest by the gateway.</summary>
    public string ApiKey { get; set; } = "";
    public string ApiKeyHeader { get; set; } = "Authorization";
    public Dictionary<string, string> Headers { get; set; } = new();
    public int TimeoutMs { get; set; } = 60000;
}

/// <summary>
/// Generic HTTP JSON translation backend (spec 2.0 §5.4 item 4): body
/// template + response dot-path, mirroring the extension's custom-http
/// provider idea. Credentials live in the gateway config, never in the
/// browser (spec 2.0 §5.1).
/// </summary>
public sealed class HttpBackend : IGatewayBackend
{
    private static readonly HttpClient Http = new() { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

    private readonly HttpBackendConfig _config;

    public HttpBackend(HttpBackendConfig config) => _config = config;

    public string Id => _config.Id;
    public string Name => _config.Name;
    public string Kind => "http";
    public BackendCapabilities Capabilities => new(SupportsStreaming: false, MaxBatchItems: 50, MaxBatchChars: 20000);

    public IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct) => null;

    public Task<BackendHealth> ProbeAsync(CancellationToken ct)
    {
        var ok = !string.IsNullOrWhiteSpace(_config.Url);
        return Task.FromResult(ok
            ? new BackendHealth(true, $"已配置：{_config.Url}")
            : new BackendHealth(false, "未配置 url"));
    }

    public async Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
    {
        if (texts.Count == 0) return Array.Empty<string>();
        if (string.IsNullOrWhiteSpace(_config.Url))
        {
            throw new GatewayBackendException(RpcCodes.Config, $"后端 {Id} 未配置 url");
        }
        var supportsBatch = _config.BodyTemplate.Contains("{{texts}}");
        if (supportsBatch || texts.Count == 1)
        {
            var json = await RequestAsync(texts, ctx, ct);
            return ParseResult(json, texts.Count);
        }
        var results = new List<string>();
        foreach (var text in texts)
        {
            var json = await RequestAsync(new[] { text }, ctx, ct);
            results.AddRange(ParseResult(json, 1));
        }
        return results.ToArray();
    }

    private async Task<JsonElement> RequestAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(_config.TimeoutMs);
        try
        {
            var method = _config.Method.Trim().ToUpperInvariant() switch
            {
                "GET" => HttpMethod.Get,
                "PUT" => HttpMethod.Put,
                "PATCH" => HttpMethod.Patch,
                _ => HttpMethod.Post,
            };
            using var req = new HttpRequestMessage(method, _config.Url);
            foreach (var header in _config.Headers)
            {
                req.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            if (!string.IsNullOrWhiteSpace(_config.ApiKey))
            {
                var headerName = string.IsNullOrWhiteSpace(_config.ApiKeyHeader) ? "Authorization" : _config.ApiKeyHeader;
                var headerValue = headerName.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                    ? $"Bearer {_config.ApiKey}"
                    : _config.ApiKey;
                req.Headers.TryAddWithoutValidation(headerName, headerValue);
            }
            if (method != HttpMethod.Get)
            {
                req.Content = new StringContent(RenderBody(texts, ctx), Encoding.UTF8, "application/json");
            }
            using var res = await Http.SendAsync(req, timeoutCts.Token);
            if (!res.IsSuccessStatusCode)
            {
                throw new GatewayBackendException(ClassifyStatus((int)res.StatusCode),
                    $"后端 {Id} 请求失败 (HTTP {(int)res.StatusCode})");
            }
            var body = await res.Content.ReadAsStringAsync(timeoutCts.Token);
            try
            {
                return JsonDocument.Parse(body).RootElement.Clone();
            }
            catch (JsonException)
            {
                throw new GatewayBackendException(RpcCodes.InvalidResponse, $"后端 {Id} 返回了非 JSON 内容");
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new GatewayBackendException(RpcCodes.Timeout, $"后端 {Id} 请求超时（{_config.TimeoutMs}ms）");
        }
        catch (HttpRequestException e)
        {
            throw new GatewayBackendException(RpcCodes.Network, $"后端 {Id} 网络错误：{e.Message}", e);
        }
    }

    private string RenderBody(IReadOnlyList<string> texts, TranslateContext ctx)
    {
        var vars = new Dictionary<string, string>
        {
            ["texts"] = JsonSerializer.Serialize(texts),
            ["text"] = JsonSerializer.Serialize(texts.Count > 0 ? texts[0] : ""),
            ["sourceLanguage"] = JsonSerializer.Serialize(ctx.Source),
            ["targetLanguage"] = JsonSerializer.Serialize(ctx.Target),
            ["apiKey"] = JsonSerializer.Serialize(_config.ApiKey),
        };
        // {{texts}}/{{text}} already carry their own quotes as JSON values.
        var rendered = _config.BodyTemplate
            .Replace("{{texts}}", vars["texts"])
            .Replace("{{text}}", vars["text"]);
        var stringVars = new Dictionary<string, string>
        {
            ["sourceLanguage"] = ctx.Source,
            ["targetLanguage"] = ctx.Target,
            ["apiKey"] = _config.ApiKey,
        };
        rendered = TemplateHelper.Render(rendered, stringVars);
        try
        {
            using var _ = JsonDocument.Parse(rendered);
        }
        catch (JsonException)
        {
            throw new GatewayBackendException(RpcCodes.Config, $"后端 {Id} 的 body 模板替换变量后不是合法 JSON");
        }
        return rendered;
    }

    private string[] ParseResult(JsonElement json, int expectedCount)
    {
        var value = TemplateHelper.GetByPath(json, _config.ResponsePath);
        if (value is null)
        {
            throw new GatewayBackendException(RpcCodes.InvalidResponse,
                $"后端 {Id} 响应缺少路径 \"{_config.ResponsePath}\"");
        }
        var texts = TemplateHelper.ExtractStrings(value.Value);
        if (texts is null)
        {
            throw new GatewayBackendException(RpcCodes.InvalidResponse,
                $"后端 {Id} 无法从响应路径解析出译文");
        }
        if (texts.Count == expectedCount) return texts.ToArray();
        if (expectedCount == 1 && texts.Count > 0) return new[] { string.Join("\n", texts) };
        throw new GatewayBackendException(RpcCodes.InvalidResponse,
            $"后端 {Id} 译文数量不匹配（期望 {expectedCount} 条，实际 {texts.Count} 条）");
    }

    private static int ClassifyStatus(int status) => status switch
    {
        401 or 403 => RpcCodes.Auth,
        429 => RpcCodes.RateLimit,
        >= 500 => RpcCodes.Server,
        _ => RpcCodes.Config,
    };
}