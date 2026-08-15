using System.Text.Json;
using PolyPage.Gateway;
using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>In-memory backend used by the protocol contract tests.</summary>
internal sealed class FakeBackend : IGatewayBackend
{
    public string Id { get; init; } = "fake";
    public string Name { get; init; } = "Fake backend";
    public string Kind => "fake";
    public BackendCapabilities Capabilities { get; init; } = new(true, 10, 6000);
    public bool FailWithNetwork { get; set; }

    public Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
    {
        if (FailWithNetwork) throw new GatewayBackendException(RpcCodes.Network, "模拟网络错误");
        return Task.FromResult(texts.Select(x => "[fake] " + x).ToArray());
    }

    private static async IAsyncEnumerable<string> Words(string text)
    {
        foreach (var word in text.Split(' '))
        {
            await Task.Yield();
            yield return word + " ";
        }
    }

    public IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct)
        => Words(text);

    public Task<BackendHealth> ProbeAsync(CancellationToken ct)
        => Task.FromResult(new BackendHealth(true, "fake ok"));
}

/// <summary>Backend that blocks until cancelled (for cancel-semantics tests).</summary>
internal sealed class BlockingBackend : IGatewayBackend
{
    public string Id => "blocking";
    public string Name => "Blocking backend";
    public string Kind => "blocking";
    public BackendCapabilities Capabilities => new(false, 10, 6000);
    public bool WasCancelled { get; private set; }

    public async Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
    {
        try
        {
            await Task.Delay(30000, ct);
            return texts.ToArray();
        }
        catch (OperationCanceledException)
        {
            WasCancelled = true;
            throw;
        }
    }

    public IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct) => null;

    public Task<BackendHealth> ProbeAsync(CancellationToken ct) => Task.FromResult(new BackendHealth(true, "ok"));
}

internal static class Pipe
{
    public static byte[] Frame(object message)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message);
        var frame = new byte[4 + payload.Length];
        BitConverter.GetBytes(payload.Length).CopyTo(frame, 0);
        payload.CopyTo(frame, 4);
        return frame;
    }

    public static async Task<List<JsonElement>> RunAsync(IEnumerable<object> requests, params IGatewayBackend[] backends)
    {
        using var log = new GatewayLog();
        var server = new GatewayServer(backends, backends[0].Id, log);
        var input = new MemoryStream();
        foreach (var request in requests) input.Write(Frame(request));
        input.Position = 0;
        var output = new MemoryStream();
        await server.RunAsync(input, output, CancellationToken.None);
        output.Position = 0;
        var responses = new List<JsonElement>();
        for (; ; )
        {
            var frame = await NativeMessaging.ReadFrameAsync(output, CancellationToken.None);
            if (frame is null) break;
            responses.Add(JsonSerializer.Deserialize<JsonElement>(frame));
        }
        return responses;
    }

    public static object Request(int id, string method, object? @params = null) => new
    {
        jsonrpc = "2.0",
        id,
        method,
        @params,
    };
}

/// <summary>
/// JSON-RPC protocol contract tests: run the real GatewayServer over
/// in-memory streams and assert wire-level behavior (spec 2.0 §12.1).
/// </summary>
public class GatewayServerTests
{
    [Fact]
    public async Task PingReturnsProtocolAndVersion()
    {
        var responses = await Pipe.RunAsync(new[] { Pipe.Request(1, "ping") }, new FakeBackend());
        var result = responses.Single().GetProperty("result");
        Assert.Equal(2, result.GetProperty("protocol").GetInt32());
        Assert.Equal(GatewayServer.Version, result.GetProperty("version").GetString());
        Assert.Equal(GatewayServer.Name, result.GetProperty("name").GetString());
    }

    [Fact]
    public async Task CapabilitiesListsBackendsAndStreaming()
    {
        var responses = await Pipe.RunAsync(new[] { Pipe.Request(1, "capabilities") }, new FakeBackend());
        var result = responses.Single().GetProperty("result");
        Assert.Contains("fake", result.GetProperty("backends").EnumerateArray().Select(e => e.GetString()));
        Assert.True(result.GetProperty("supportsStreaming").GetBoolean());
        Assert.False(result.GetProperty("supportsVision").GetBoolean());
        Assert.False(result.GetProperty("supportsAsr").GetBoolean());
        Assert.Equal(GatewayServer.DefaultMaxBinaryBytes, result.GetProperty("maxBinaryBytes").GetInt32());
    }

    [Fact]
    public async Task TranslateReturnsTranslationsInOrder()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(7, "translate", new { texts = new[] { "hello", "world" }, source = "English", target = "Chinese" }),
        }, new FakeBackend());
        var response = responses.Single();
        Assert.Equal(7, response.GetProperty("id").GetInt32());
        var translations = response.GetProperty("result").GetProperty("translations");
        Assert.Equal(new[] { "[fake] hello", "[fake] world" },
            translations.EnumerateArray().Select(e => e.GetString()).ToArray());
        Assert.Equal("fake", response.GetProperty("result").GetProperty("backend").GetString());
    }

    [Fact]
    public async Task BackendErrorsMapToRpcCodes()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(2, "translate", new { texts = new[] { "x" } }),
        }, new FakeBackend { FailWithNetwork = true });
        var error = responses.Single().GetProperty("error");
        Assert.Equal(RpcCodes.Network, error.GetProperty("code").GetInt32());
    }

    [Fact]
    public async Task BatchLimitsAreEnforced()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(3, "translate", new
            {
                texts = Enumerable.Range(0, 11).Select(i => "t" + i).ToArray(),
            }),
        }, new FakeBackend());
        var error = responses.Single().GetProperty("error");
        Assert.Equal(RpcCodes.Config, error.GetProperty("code").GetInt32());
        Assert.Contains("预切分", error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task UnknownBackendIsConfigError()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(4, "translate", new { texts = new[] { "x" }, backend = "nope" }),
        }, new FakeBackend());
        var error = responses.Single().GetProperty("error");
        Assert.Equal(RpcCodes.Config, error.GetProperty("code").GetInt32());
    }

    [Fact]
    public async Task UnknownMethodIsMethodNotFound()
    {
        var responses = await Pipe.RunAsync(new[] { Pipe.Request(5, "no.such.method") }, new FakeBackend());
        var error = responses.Single().GetProperty("error");
        Assert.Equal(JsonRpc.MethodNotFound, error.GetProperty("code").GetInt32());
    }

    [Fact]
    public async Task StreamEmitsDeltaNotificationsThenFinalResult()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(9, "translate.stream", new { text = "aa bb", source = "en", target = "zh" }),
        }, new FakeBackend());

        var deltas = responses
            .Where(r => r.TryGetProperty("method", out var m) && m.GetString() == "translate.delta")
            .ToList();
        Assert.Equal(2, deltas.Count);
        foreach (var delta in deltas)
        {
            Assert.Equal(9, delta.GetProperty("params").GetProperty("id").GetInt64());
        }
        var final = responses.Single(
            r => r.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.GetInt32() == 9);
        Assert.Equal("aa bb ", final.GetProperty("result").GetProperty("translation").GetString());
    }

    [Fact]
    public async Task CancelAbortsAnInProgressTranslate()
    {
        // A backend that blocks until its cancellation token fires.
        var blocking = new BlockingBackend();
        using var log = new GatewayLog();
        var server = new GatewayServer(new IGatewayBackend[] { blocking }, blocking.Id, log);

        var input = new MemoryStream();
        input.Write(Pipe.Frame(new { jsonrpc = "2.0", id = 21, method = "translate", @params = new { texts = new[] { "x" } } }));
        input.Write(Pipe.Frame(new { jsonrpc = "2.0", id = 22, method = "cancel", @params = new { id = 21 } }));
        input.Position = 0;
        var output = new MemoryStream();

        await server.RunAsync(input, output, CancellationToken.None);

        output.Position = 0;
        var responses = new List<System.Text.Json.JsonElement>();
        for (; ; )
        {
            var frame = await NativeMessaging.ReadFrameAsync(output, CancellationToken.None);
            if (frame is null) break;
            responses.Add(System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(frame));
        }

        var cancelled = responses.FirstOrDefault(
            r => r.TryGetProperty("id", out var id) && id.ValueKind == System.Text.Json.JsonValueKind.Number && id.GetInt32() == 21);
        Assert.True(cancelled.TryGetProperty("error", out var error), "translate #21 should have been cancelled");
        Assert.Equal(RpcCodes.Timeout, error.GetProperty("code").GetInt32());
        Assert.True(blocking.WasCancelled, "backend cancellation token must fire");
    }

    [Fact]
    public async Task BackendsListAndHealth()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(10, "backends.list"),
            Pipe.Request(11, "health"),
        }, new FakeBackend());
        var list = responses.First(r => r.GetProperty("id").GetInt32() == 10);
        Assert.Equal("fake", list.GetProperty("result").GetProperty("backends")[0].GetProperty("id").GetString());
        var health = responses.First(r => r.GetProperty("id").GetInt32() == 11);
        Assert.True(health.GetProperty("result").GetProperty("backends")[0].GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task BinaryChunkAssemblesAndOptionalSha256()
    {
        var payload = Enumerable.Range(0, 100).Select(i => (byte)i).ToArray();
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(payload)).ToLowerInvariant();
        var mid = payload.Length / 2;
        var chunks = new object[]
        {
            Pipe.Request(30, "binary.chunk", new
            {
                transferId = "t-sha",
                index = 0,
                total = 2,
                mime = "application/octet-stream",
                sha256 = sha,
                data = Convert.ToBase64String(payload[..mid]),
            }),
            Pipe.Request(31, "binary.chunk", new
            {
                transferId = "t-sha",
                index = 1,
                total = 2,
                mime = "application/octet-stream",
                sha256 = sha,
                data = Convert.ToBase64String(payload[mid..]),
            }),
        };
        var responses = await Pipe.RunAsync(chunks, new MultimodalFakeBackend());
        var last = responses.Single(r => r.GetProperty("id").GetInt32() == 31).GetProperty("result");
        Assert.True(last.GetProperty("complete").GetBoolean());
        Assert.Equal(payload.Length, last.GetProperty("bytes").GetInt32());
        Assert.Equal(sha, last.GetProperty("sha256").GetString());
    }

    [Fact]
    public async Task TranslateImageViaSmallDataUrl()
    {
        var dataUrl = "data:image/png;base64," + Convert.ToBase64String(new byte[] { 1, 2, 3 });
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(40, "translate.image", new { dataUrl, source = "en", target = "zh" }),
        }, new MultimodalFakeBackend());
        var segs = responses.Single().GetProperty("result").GetProperty("segments");
        Assert.Equal("hello", segs[0].GetProperty("text").GetString());
        Assert.Equal("[img] hello", segs[0].GetProperty("translation").GetString());
    }

    [Fact]
    public async Task TranscribeRequiresTransferId()
    {
        var inline = await Pipe.RunAsync(new[]
        {
            Pipe.Request(41, "transcribe", new { dataUrl = "data:audio/webm;base64,AA==" }),
        }, new MultimodalFakeBackend());
        Assert.Equal(-32602, inline.Single().GetProperty("error").GetProperty("code").GetInt32());

        var audio = new byte[] { 9, 8, 7, 6 };
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(audio)).ToLowerInvariant();
        var ok = await Pipe.RunAsync(new[]
        {
            Pipe.Request(42, "binary.chunk", new
            {
                transferId = "aud1",
                index = 0,
                total = 1,
                mime = "audio/webm",
                sha256 = sha,
                data = Convert.ToBase64String(audio),
            }),
            Pipe.Request(43, "transcribe", new { transferId = "aud1", source = "en" }),
        }, new MultimodalFakeBackend());
        var result = ok.Single(r => r.GetProperty("id").GetInt32() == 43).GetProperty("result");
        Assert.Equal("hello from audio", result.GetProperty("text").GetString());
    }

    [Fact]
    public async Task TranslateStillWorksOnMultimodalGateway()
    {
        var responses = await Pipe.RunAsync(new[]
        {
            Pipe.Request(7, "translate", new { texts = new[] { "hello" }, source = "en", target = "zh" }),
        }, new MultimodalFakeBackend());
        Assert.Equal("[fake] hello", responses.Single().GetProperty("result").GetProperty("translations")[0].GetString());
    }
}

/// <summary>Fake backend that implements vision + ASR for protocol v2 tests.</summary>
internal sealed class MultimodalFakeBackend : IGatewayBackend
{
    public string Id => "multi";
    public string Name => "Multimodal fake";
    public string Kind => "fake";
    public BackendCapabilities Capabilities => new(true, 10, 6000, SupportsVision: true, SupportsAsr: true);

    public Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct)
        => Task.FromResult(texts.Select(x => "[fake] " + x).ToArray());

    public IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct) => null;

    public Task<BackendHealth> ProbeAsync(CancellationToken ct)
        => Task.FromResult(new BackendHealth(true, "ok"));

    public Task<ImageTranslateResult?> TranslateImageAsync(byte[] image, string mime, TranslateContext ctx, CancellationToken ct)
        => Task.FromResult<ImageTranslateResult?>(new ImageTranslateResult(new[] { new ImageSegment("hello", "[img] hello") }));

    public Task<TranscriptResult?> TranscribeAsync(byte[] audio, string mime, TranslateContext ctx, CancellationToken ct)
        => Task.FromResult<TranscriptResult?>(new TranscriptResult("hello from audio", new[] { new TranscriptSegment(0, 1, "hello from audio") }));
}