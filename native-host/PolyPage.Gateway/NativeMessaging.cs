using System.Buffers.Binary;

namespace PolyPage.Gateway;

/// <summary>
/// Native Messaging transport framing (spec 2.0 §5.2 item 1):
/// 32-bit little-endian length prefix + UTF-8 JSON payload.
/// Reads and writes run on separate tasks to avoid stdio deadlocks
/// (spec 2.0 §5.4 item 2).
/// </summary>
public static class NativeMessaging
{
    public const int MaxMessageBytes = 1024 * 1024;

    /// <summary>Read one frame; returns null on clean end of stream.</summary>
    public static async Task<byte[]?> ReadFrameAsync(Stream input, CancellationToken ct)
    {
        var header = await ReadExactAsync(input, 4, ct);
        if (header is null) return null;
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > MaxMessageBytes)
        {
            throw new InvalidDataException($"非法 Native Messaging 帧长度: {length}");
        }
        var payload = await ReadExactAsync(input, length, ct);
        if (payload is null) throw new InvalidDataException("流在帧中途结束");
        return payload;
    }

    public static async Task WriteFrameAsync(Stream output, byte[] payload, CancellationToken ct)
    {
        if (payload.Length > MaxMessageBytes)
        {
            throw new InvalidOperationException(
                $"响应超过 1MB 上限（{payload.Length} 字节）：请在扩展侧按 maxBatchChars 预切分");
        }
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await output.WriteAsync(header, ct);
        await output.WriteAsync(payload, ct);
        await output.FlushAsync(ct);
    }

    private static async Task<byte[]?> ReadExactAsync(Stream input, int count, CancellationToken ct)
    {
        var buffer = new byte[count];
        var read = 0;
        while (read < count)
        {
            var n = await input.ReadAsync(buffer.AsMemory(read, count - read), ct);
            if (n == 0)
            {
                return read == 0 ? null : throw new InvalidDataException("流在帧中途结束");
            }
            read += n;
        }
        return buffer;
    }
}