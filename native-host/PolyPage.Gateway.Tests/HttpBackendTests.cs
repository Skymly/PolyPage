using System.Net;
using System.Text;
using System.Text.Json;
using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>
/// HttpBackend contract tests against a local HttpListener stub:
/// body template rendering, auth header, response path parsing, error mapping.
/// </summary>
public class HttpBackendTests : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _baseUrl;
    private string _responseJson = "{}";
    private int _responseStatus = 200;
    private string _lastBody = "";
    private string _lastAuth = "";

    public HttpBackendTests()
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
                try
                {
                    ctx = await _listener.GetContextAsync();
                }
                catch
                {
                    break;
                }
                using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
                _lastBody = await reader.ReadToEndAsync();
                _lastAuth = ctx.Request.Headers["Authorization"] ?? "";
                var payload = Encoding.UTF8.GetBytes(_responseJson);
                ctx.Response.StatusCode = _responseStatus;
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

    private HttpBackend MakeBackend(string responsePath) => new(new HttpBackendConfig
    {
        Id = "stub",
        Url = _baseUrl + "translate",
        ApiKey = "secret-key",
        BodyTemplate = "{ \"q\": {{texts}}, \"from\": \"{{sourceLanguage}}\", \"to\": \"{{targetLanguage}}\" }",
        ResponsePath = responsePath,
        TimeoutMs = 5000,
    });

    [Fact]
    public async Task RendersTemplateAndParsesResponsePath()
    {
        _responseJson = "{\"data\":{\"translations\":[\"一\",\"二\"]}}";
        var backend = MakeBackend("data.translations");
        var result = await backend.TranslateAsync(
            new[] { "one", "two" }, new TranslateContext("en", "zh"), CancellationToken.None);
        Assert.Equal(new[] { "一", "二" }, result);

        using var doc = JsonDocument.Parse(_lastBody);
        Assert.Equal(new[] { "one", "two" },
            doc.RootElement.GetProperty("q").EnumerateArray().Select(e => e.GetString()).ToArray());
        Assert.Equal("en", doc.RootElement.GetProperty("from").GetString());
        Assert.Equal("Bearer secret-key", _lastAuth);
    }

    [Fact]
    public async Task MapsHttp500ToServerRpcCode()
    {
        _responseStatus = 500;
        _responseJson = "{}";
        var backend = MakeBackend("data.translations");
        var ex = await Assert.ThrowsAsync<GatewayBackendException>(
            () => backend.TranslateAsync(new[] { "x" }, new TranslateContext("en", "zh"), CancellationToken.None));
        Assert.Equal(RpcCodes.Server, ex.RpcCode);
    }

    [Fact]
    public async Task MissingResponsePathIsInvalidResponse()
    {
        _responseJson = "{\"other\":1}";
        var backend = MakeBackend("data.translations");
        var ex = await Assert.ThrowsAsync<GatewayBackendException>(
            () => backend.TranslateAsync(new[] { "x" }, new TranslateContext("en", "zh"), CancellationToken.None));
        Assert.Equal(RpcCodes.InvalidResponse, ex.RpcCode);
    }

    [Fact]
    public async Task CountMismatchIsInvalidResponse()
    {
        _responseJson = "{\"data\":{\"translations\":[\"only\"]}}";
        var backend = MakeBackend("data.translations");
        var ex = await Assert.ThrowsAsync<GatewayBackendException>(
            () => backend.TranslateAsync(new[] { "a", "b" }, new TranslateContext("en", "zh"), CancellationToken.None));
        Assert.Equal(RpcCodes.InvalidResponse, ex.RpcCode);
    }

    [Fact]
    public async Task ProbeReportsConfiguredUrl()
    {
        var backend = MakeBackend("data.translations");
        var health = await backend.ProbeAsync(CancellationToken.None);
        Assert.True(health.Ok);
        Assert.Contains(_baseUrl, health.Detail);
    }

    public void Dispose()
    {
        try
        {
            _listener.Stop();
            _listener.Close();
        }
        catch
        {
            // ignore
        }
    }
}