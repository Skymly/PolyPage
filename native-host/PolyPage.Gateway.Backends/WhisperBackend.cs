using System.Net.Http.Headers;
using System.Text.Json;

namespace PolyPage.Gateway.Backends;

/// <summary>User-installed Whisper HTTP or whisper.cpp CLI (spec 4.0 §6.3 P1).</summary>
public sealed class WhisperBackendConfig
{
    public string Id { get; set; } = "whisper";
    public string Name { get; set; } = "Whisper";
    public string Url { get; set; } = "";
    public string Model { get; set; } = "whisper-1";
    public string ApiKey { get; set; } = "";
    public string? Command { get; set; }
    public int TimeoutMs { get; set; } = 180000;
}

/// <summary>
/// Orchestrates a user-installed faster-whisper HTTP endpoint or whisper.cpp
/// CLI. Does not ship model weights (spec 4.0 §0 item 5).
/// </summary>
public sealed class WhisperBackend : IGatewayBackend
{
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly WhisperBackendConfig _config;

    public WhisperBackend(WhisperBackendConfig config) => _config = config;

    public string Id => _config.Id;
    public string Name => _config.Name;
    public string Kind => "whisper";
    public BackendCapabilities Capabilities => new(false, 1, 1, SupportsVision: false, SupportsAsr: true);

    public Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
        => throw new GatewayBackendException(RpcCodes.Config, "Whisper 后端只支持 transcribe，不支持文本翻译");

    public IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct) => null;

    public async Task<BackendHealth> ProbeAsync(CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_config.Command))
            return new BackendHealth(true, "whisper.cpp 命令已配置（未探测可执行文件）");
        if (string.IsNullOrWhiteSpace(_config.Url))
            return new BackendHealth(false, "未配置 Whisper HTTP url");
        return new BackendHealth(true, $"Whisper HTTP {_config.Url}");
    }

    public async Task<TranscriptResult?> TranscribeAsync(byte[] audio, string mime, TranslateContext ctx, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_config.Command))
            return await TranscribeViaCommandAsync(audio, mime, ct);
        if (string.IsNullOrWhiteSpace(_config.Url))
            throw new GatewayBackendException(RpcCodes.Config, "Whisper 后端未配置 url 或 command");
        return await TranscribeViaHttpAsync(audio, mime, ctx, ct);
    }

    private async Task<TranscriptResult> TranscribeViaHttpAsync(byte[] audio, string mime, TranslateContext ctx, CancellationToken ct)
    {
        var url = TranscriptionUrl(_config.Url);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(_config.TimeoutMs);
        using var content = new MultipartFormDataContent();
        var file = new ByteArrayContent(audio);
        file.Headers.ContentType = new MediaTypeHeaderValue(string.IsNullOrWhiteSpace(mime) ? "audio/webm" : mime);
        content.Add(file, "file", "audio.webm");
        content.Add(new StringContent(_config.Model), "model");
        content.Add(new StringContent("verbose_json"), "response_format");
        if (!string.IsNullOrWhiteSpace(ctx.Source) && ctx.Source != "auto")
            content.Add(new StringContent(ctx.Source), "language");
        using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = content };
        if (!string.IsNullOrWhiteSpace(_config.ApiKey))
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_config.ApiKey}");
        try
        {
            using var res = await Http.SendAsync(req, timeoutCts.Token);
            var raw = await res.Content.ReadAsStringAsync(timeoutCts.Token);
            if (!res.IsSuccessStatusCode)
            {
                throw new GatewayBackendException(ClassifyStatus((int)res.StatusCode),
                    $"Whisper 请求失败 (HTTP {(int)res.StatusCode})");
            }
            return ParseVerboseJson(raw);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new GatewayBackendException(RpcCodes.Timeout, $"Whisper 请求超时（{_config.TimeoutMs}ms）");
        }
        catch (HttpRequestException e)
        {
            throw new GatewayBackendException(RpcCodes.Network, $"无法连接 Whisper：{e.Message}", e);
        }
    }

    private async Task<TranscriptResult> TranscribeViaCommandAsync(byte[] audio, string mime, CancellationToken ct)
    {
        var ext = mime.Contains("mp4", StringComparison.OrdinalIgnoreCase) ? ".mp4" : ".webm";
        var tmp = Path.Combine(Path.GetTempPath(), $"polypage-whisper-{Guid.NewGuid():N}{ext}");
        await File.WriteAllBytesAsync(tmp, audio, ct);
        try
        {
            var command = _config.Command!.Replace("{input}", tmp).Replace("{model}", _config.Model);
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = command.Split(' ', 2)[0],
                Arguments = command.Contains(' ') ? command[(command.IndexOf(' ') + 1)..] : "",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = System.Diagnostics.Process.Start(psi)
                ?? throw new GatewayBackendException(RpcCodes.Config, "无法启动 whisper.cpp 命令");
            var stdout = await proc.StandardOutput.ReadToEndAsync(ct);
            await proc.WaitForExitAsync(ct);
            if (proc.ExitCode != 0)
            {
                var err = await proc.StandardError.ReadToEndAsync(ct);
                throw new GatewayBackendException(RpcCodes.Server, $"whisper.cpp 退出码 {proc.ExitCode}: {err}");
            }
            try
            {
                return ParseVerboseJson(stdout);
            }
            catch (GatewayBackendException)
            {
                return new TranscriptResult(stdout.Trim(), null);
            }
        }
        finally
        {
            try { File.Delete(tmp); } catch { /* best effort */ }
        }
    }

    private static string TranscriptionUrl(string url)
    {
        var trimmed = url.TrimEnd('/');
        if (trimmed.Contains("/audio/transcriptions", StringComparison.OrdinalIgnoreCase)) return trimmed;
        if (trimmed.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) return trimmed + "/audio/transcriptions";
        return trimmed + "/v1/audio/transcriptions";
    }

    private static TranscriptResult ParseVerboseJson(string raw)
    {
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;
        var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : raw;
        List<TranscriptSegment>? segments = null;
        if (root.TryGetProperty("segments", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            segments = new List<TranscriptSegment>();
            foreach (var item in arr.EnumerateArray())
            {
                var segText = item.TryGetProperty("text", out var st) ? st.GetString() ?? "" : "";
                if (string.IsNullOrWhiteSpace(segText)) continue;
                var start = item.TryGetProperty("start", out var s) && s.TryGetDouble(out var sd) ? sd : 0;
                var end = item.TryGetProperty("end", out var e) && e.TryGetDouble(out var ed) ? ed : 0;
                segments.Add(new TranscriptSegment(start, end, segText.Trim()));
            }
        }
        if (string.IsNullOrWhiteSpace(text) && (segments is null || segments.Count == 0))
            throw new GatewayBackendException(RpcCodes.InvalidResponse, "Whisper 返回了空内容");
        return new TranscriptResult(text.Trim(), segments);
    }

    private static int ClassifyStatus(int status) => status switch
    {
        401 or 403 => RpcCodes.Auth,
        429 => RpcCodes.RateLimit,
        >= 500 => RpcCodes.Server,
        _ => RpcCodes.Config,
    };
}
