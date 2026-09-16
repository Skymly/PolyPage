using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>M-72: DPAPI covers HttpBackend headers values, not just named secret keys.</summary>
[CollectionDefinition("serial-gateway-config", DisableParallelization = true)]
public class SerialGatewayConfigCollection { }

[Collection("serial-gateway-config")]
public class GatewayConfigTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "polypage-gw-cfg-" + Guid.NewGuid().ToString("N") + ".json");
    private readonly string? _prev = Environment.GetEnvironmentVariable("POLYPAGE_GATEWAY_CONFIG");

    public GatewayConfigTests()
    {
        Environment.SetEnvironmentVariable("POLYPAGE_GATEWAY_CONFIG", _path);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("POLYPAGE_GATEWAY_CONFIG", _prev);
        try { File.Delete(_path); } catch { /* temp */ }
    }

    [Fact]
    public async Task HeaderValuesAreEncryptedAtRestAndRestoredOnLoad()
    {
        var cfg = new GatewayConfig
        {
            DefaultBackend = "h",
            Http =
            {
                new HttpBackendConfig
                {
                    Id = "h",
                    ApiKey = "top-secret-key",
                    Headers = { ["Authorization"] = "Bearer header-secret" },
                },
            },
        };
        await GatewayConfig.SaveAsync(cfg);
        var raw = await File.ReadAllTextAsync(_path);
        Assert.Contains("$enc:", raw);
        Assert.DoesNotContain("Bearer header-secret", raw);
        Assert.DoesNotContain("top-secret-key", raw);

        var loaded = await GatewayConfig.LoadAsync();
        Assert.Equal("Bearer header-secret", loaded.Http[0].Headers["Authorization"]);
        Assert.Equal("top-secret-key", loaded.Http[0].ApiKey);
    }
}
