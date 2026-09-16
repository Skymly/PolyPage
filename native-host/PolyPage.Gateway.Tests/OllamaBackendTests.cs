using System.Net;
using System.Text;
using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>M-48: Ollama batch / retry / SSE / vision against a local HttpListener.</summary>
public class OllamaBackendTests : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _baseUrl;
    private int _chatCalls;
    private Func<int, (int Status, string Body, bool Sse)> _chat = _ => (200, ChatJson("[\"一\",\"二\"]"), false);
    private string _lastPath = "";

    public OllamaBackendTests()
    {
        var port = GetFreePort();
        _baseUrl = $"http://127.0.0.1:{port}";
        _listener.Prefixes.Add(_baseUrl + "/");
        _listener.Start();
        _ = Task.Run(ServeAsync);
    }

    private async Task ServeAsync()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync();
            }
            catch
            {
                break;
            }

            try
            {
                _lastPath = ctx.Request.Url?.AbsolutePath ?? "";
                if (ctx.Request.HttpMethod == "GET" && _lastPath.EndsWith("/api/tags", StringComparison.Ordinal))
                {
                    await Write(ctx, 200, "{\"models\":[{\"name\":\"llama3\"}]}", "application/json");
                    continue;
                }

                var n = Interlocked.Increment(ref _chatCalls);
                var (status, body, sse) = _chat(n);
                if (sse)
                {
                    ctx.Response.StatusCode = status;
                    ctx.Response.ContentType = "text/event-stream";
                    var bytes = Encoding.UTF8.GetBytes(body);
                    await ctx.Response.OutputStream.WriteAsync(bytes);
                    ctx.Response.Close();
                    continue;
                }

                await Write(ctx, status, body, "application/json");
            }
            catch
            {
                try { ctx.Response.Abort(); } catch { /* closed */ }
            }
        }
    }

    private static async Task Write(HttpListenerContext ctx, int status, string body, string contentType)
    {
        var payload = Encoding.UTF8.GetBytes(body);
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = contentType;
        ctx.Response.ContentLength64 = payload.Length;
        await ctx.Response.OutputStream.WriteAsync(payload);
        ctx.Response.Close();
    }

    private static string ChatJson(string content) =>
        "{\"choices\":[{\"message\":{\"content\":" + System.Text.Json.JsonSerializer.Serialize(content) + "}}]}";

    private OllamaBackend Make(bool vision = false) => new(new OllamaBackendConfig
    {
        Id = "ollama",
        BaseUrl = _baseUrl,
        Model = "llama3",
        TimeoutMs = 5000,
        SupportsVision = vision,
    });

    private static int GetFreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    [Fact]
    public async Task TranslateParsesChatJsonArray()
    {
        var result = await Make().TranslateAsync(
            new[] { "one", "two" }, new TranslateContext("en", "zh"), CancellationToken.None);
        Assert.Equal(new[] { "一", "二" }, result);
        Assert.Equal(1, _chatCalls);
    }

    [Fact]
    public async Task UnparseableBatchRetriesItemByItemWhenCountAtMostSix()
    {
        _chat = n => n switch
        {
            1 => (200, ChatJson("not a batch"), false),
            2 => (200, ChatJson("一"), false),
            _ => (200, ChatJson("二"), false),
        };
        var result = await Make().TranslateAsync(
            new[] { "one", "two" }, new TranslateContext("en", "zh"), CancellationToken.None);
        Assert.Equal(new[] { "一", "二" }, result);
        Assert.Equal(3, _chatCalls);
    }

    [Fact]
    public async Task StreamYieldsSseDeltas()
    {
        _chat = _ => (200, "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\ndata: [DONE]\n\n", true);
        var chunks = new List<string>();
        await foreach (var delta in Make().StreamAsync("hi", new TranslateContext("en", "zh"), CancellationToken.None)!)
            chunks.Add(delta);
        Assert.Equal(new[] { "你", "好" }, chunks);
    }

    [Fact]
    public async Task VisionParsesFencedJsonArray()
    {
        _chat = _ => (200, ChatJson("```json\n[{\"text\":\"HELLO\",\"translation\":\"你好\"}]\n```"), false);
        var result = await Make(vision: true).TranslateImageAsync(
            new byte[] { 1, 2, 3 }, "image/png", new TranslateContext("en", "zh"), CancellationToken.None);
        Assert.NotNull(result);
        Assert.Single(result!.Segments);
        Assert.Equal("HELLO", result.Segments[0].Text);
        Assert.Equal("你好", result.Segments[0].Translation);
    }

    [Fact]
    public async Task ProbeHitsApiTags()
    {
        var health = await Make().ProbeAsync(CancellationToken.None);
        Assert.True(health.Ok);
        Assert.Contains(_baseUrl, health.Detail);
        Assert.EndsWith("/api/tags", _lastPath);
    }

    [Fact]
    public async Task Http500MapsToServer()
    {
        _chat = _ => (500, "{}", false);
        var ex = await Assert.ThrowsAsync<GatewayBackendException>(
            () => Make().TranslateAsync(new[] { "x" }, new TranslateContext("en", "zh"), CancellationToken.None));
        Assert.Equal(RpcCodes.Server, ex.RpcCode);
    }

    public void Dispose()
    {
        try { _listener.Stop(); _listener.Close(); } catch { /* ignore */ }
    }
}
