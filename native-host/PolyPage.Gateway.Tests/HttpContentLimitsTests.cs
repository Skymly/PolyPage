using System.Net.Http;
using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>M-74: HTTP response bodies are capped before JSON parse.</summary>
public class HttpContentLimitsTests
{
    [Fact]
    public async Task ReadsASmallBody()
    {
        using var content = new StringContent("hello");
        var text = await HttpContentLimits.ReadBoundedStringAsync(content, CancellationToken.None);
        Assert.Equal("hello", text);
    }

    [Fact]
    public async Task RejectsABodyOverTheCap()
    {
        using var content = new ByteArrayContent(new byte[HttpContentLimits.MaxResponseBytes + 1]);
        var ex = await Assert.ThrowsAsync<GatewayBackendException>(
            () => HttpContentLimits.ReadBoundedStringAsync(content, CancellationToken.None));
        Assert.Equal(RpcCodes.InvalidResponse, ex.RpcCode);
    }
}
