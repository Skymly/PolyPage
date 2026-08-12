using System.Text;
using PolyPage.Gateway;
using Xunit;

namespace PolyPage.Gateway.Tests;

public class FrameCodecTests
{
    private static byte[] Frame(string json)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        var frame = new byte[4 + payload.Length];
        BitConverter.GetBytes(payload.Length).CopyTo(frame, 0);
        payload.CopyTo(frame, 4);
        return frame;
    }

    [Fact]
    public async Task RoundTripsFrames()
    {
        var input = new MemoryStream();
        input.Write(Frame("{\"a\":1}"));
        input.Write(Frame("{\"b\":\"中文\"}"));
        input.Position = 0;
        var first = await NativeMessaging.ReadFrameAsync(input, CancellationToken.None);
        var second = await NativeMessaging.ReadFrameAsync(input, CancellationToken.None);
        var third = await NativeMessaging.ReadFrameAsync(input, CancellationToken.None);
        Assert.Equal("{\"a\":1}", Encoding.UTF8.GetString(first!));
        Assert.Equal("{\"b\":\"中文\"}", Encoding.UTF8.GetString(second!));
        Assert.Null(third);
    }

    [Fact]
    public async Task WriteFrameProducesLittleEndianPrefix()
    {
        var output = new MemoryStream();
        var payload = Encoding.UTF8.GetBytes("{\"ok\":true}");
        await NativeMessaging.WriteFrameAsync(output, payload, CancellationToken.None);
        var bytes = output.ToArray();
        Assert.Equal(payload.Length, BitConverter.ToInt32(bytes, 0));
        Assert.Equal(payload, bytes[4..]);
    }

    [Fact]
    public async Task WriteFrameRejectsAbove1MB()
    {
        var output = new MemoryStream();
        var tooBig = new byte[NativeMessaging.MaxMessageBytes + 1];
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => NativeMessaging.WriteFrameAsync(output, tooBig, CancellationToken.None));
    }

    [Fact]
    public async Task ReadFrameRejectsDeclaredLengthAbove1MB()
    {
        var input = new MemoryStream();
        var header = BitConverter.GetBytes(NativeMessaging.MaxMessageBytes + 1);
        input.Write(header);
        input.Position = 0;
        await Assert.ThrowsAsync<InvalidDataException>(
            () => NativeMessaging.ReadFrameAsync(input, CancellationToken.None)!);
    }

    [Fact]
    public async Task ReadFrameRejectsTruncatedFrame()
    {
        var input = new MemoryStream();
        input.Write(BitConverter.GetBytes(100));
        input.Write(new byte[10]);
        input.Position = 0;
        await Assert.ThrowsAsync<InvalidDataException>(
            () => NativeMessaging.ReadFrameAsync(input, CancellationToken.None)!);
    }
}