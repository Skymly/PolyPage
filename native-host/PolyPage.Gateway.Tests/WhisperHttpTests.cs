using System.Net;
using System.Text;
using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>M-48: Whisper HTTP verbose_json path (CLI covered by M-15).</summary>
public class WhisperHttpTests : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _baseUrl;

    public WhisperHttpTests()
    {
        var port = GetFreePort();
        _baseUrl = $"http://127.0.0.1:{port}/";
        _listener.Prefixes.Add(_baseUrl);
        _listener.Start();
        _ = Task.Run(async () =>
        {
            while (_listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync(); }
                catch { break; }
                var json = "{\"text\":\"hello world\",\"segments\":[{\"start\":0,\"end\":1.5,\"text\":\"hello world\"}]}";
                var payload = Encoding.UTF8.GetBytes(json);
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "application/json";
                ctx.Response.OutputStream.Write(payload);
                ctx.Response.Close();
            }
        });
    }

    private static int GetFreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    [Fact]
    public async Task HttpTranscribeParsesVerboseJson()
    {
        var backend = new WhisperBackend(new WhisperBackendConfig
        {
            Id = "whisper-http",
            Url = _baseUrl.TrimEnd('/'),
            Model = "whisper-1",
            TimeoutMs = 5000,
        });
        var result = await backend.TranscribeAsync(
            new byte[] { 1, 2, 3 }, "audio/webm", new TranslateContext("en", "zh"), CancellationToken.None);
        Assert.Equal("hello world", result?.Text);
        Assert.NotNull(result?.Segments);
        Assert.Single(result!.Segments!);
        Assert.Equal(0, result.Segments![0].Start);
        Assert.Equal(1.5, result.Segments[0].End);
    }

    public void Dispose()
    {
        try { _listener.Stop(); _listener.Close(); } catch { /* ignore */ }
    }
}
