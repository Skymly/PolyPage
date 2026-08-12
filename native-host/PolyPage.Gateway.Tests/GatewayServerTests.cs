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
        Assert.Equal(1, result.GetProperty("protocol").GetInt32());
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
}