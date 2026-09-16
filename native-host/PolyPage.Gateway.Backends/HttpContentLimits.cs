using System.Text;

namespace PolyPage.Gateway.Backends;

/// <summary>M-74: cap outbound HTTP bodies so a huge backend reply cannot pin RAM.</summary>
public static class HttpContentLimits
{
    public const int MaxResponseBytes = 8 * 1024 * 1024;

    public static async Task<string> ReadBoundedStringAsync(
        HttpContent content,
        CancellationToken ct,
        int maxBytes = MaxResponseBytes)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var ms = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
            if (n == 0) break;
            if (ms.Length + n > maxBytes)
            {
                throw new GatewayBackendException(
                    RpcCodes.InvalidResponse,
                    $"后端响应超过 {maxBytes} 字节上限");
            }
            ms.Write(buffer, 0, n);
        }
        return Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
    }
}
