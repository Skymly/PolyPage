namespace PolyPage.Gateway.Backends;

/// <summary>Translation language context passed from the extension.</summary>
public sealed record TranslateContext(string Source, string Target);

/// <summary>Capabilities a backend advertises.</summary>
public sealed record BackendCapabilities(
    bool SupportsStreaming,
    int MaxBatchItems,
    int MaxBatchChars,
    bool SupportsVision = false,
    bool SupportsAsr = false);

/// <summary>One OCR/vision segment (spec 4.0 §6.2 translate.image).</summary>
public sealed record ImageSegment(string Text, string Translation);

/// <summary>Vision translation result.</summary>
public sealed record ImageTranslateResult(IReadOnlyList<ImageSegment> Segments);

/// <summary>One ASR segment with optional timestamps.</summary>
public sealed record TranscriptSegment(double Start, double End, string Text);

/// <summary>ASR result (spec 4.0 §6.2 transcribe).</summary>
public sealed record TranscriptResult(string Text, IReadOnlyList<TranscriptSegment>? Segments);

/// <summary>Backend metadata returned by backends.list / capabilities.</summary>
public sealed record BackendInfo(string Id, string Name, string Kind);

/// <summary>Health probe result (spec 2.0 §5.2: health method).</summary>
public sealed record BackendHealth(bool Ok, string Detail);

/// <summary>
/// A translation executor inside the gateway (spec 2.0 §5.4 item 3).
/// Isomorphic to the extension's TranslationProvider abstraction.
/// </summary>
public interface IGatewayBackend
{
    string Id { get; }
    string Name { get; }
    string Kind { get; }
    BackendCapabilities Capabilities { get; }

    /// <summary>Translate a batch of texts; results in the same order.</summary>
    Task<string[]> TranslateAsync(IReadOnlyList<string> texts, TranslateContext ctx, CancellationToken ct);

    /// <summary>
    /// Optional streaming translation of a single text. Returns null when the
    /// backend does not support streaming (caller falls back to batch mode).
    /// </summary>
    IAsyncEnumerable<string>? StreamAsync(string text, TranslateContext ctx, CancellationToken ct);

    /// <summary>Lightweight reachability probe used by the health method.</summary>
    Task<BackendHealth> ProbeAsync(CancellationToken ct);

    /// <summary>
    /// Optional vision translation. Return null when the backend does not
    /// support images (spec 4.0 §6.3).
    /// </summary>
    Task<ImageTranslateResult?> TranslateImageAsync(byte[] image, string mime, TranslateContext ctx, CancellationToken ct)
        => Task.FromResult<ImageTranslateResult?>(null);

    /// <summary>
    /// Optional ASR. Return null when the backend does not support
    /// transcription (spec 4.0 §6.3).
    /// </summary>
    Task<TranscriptResult?> TranscribeAsync(byte[] audio, string mime, TranslateContext ctx, CancellationToken ct)
        => Task.FromResult<TranscriptResult?>(null);
}

/// <summary>Backend error with a JSON-RPC-mappable code (spec 2.0 §5.2 item 5).</summary>
public sealed class GatewayBackendException : Exception
{
    public GatewayBackendException(int rpcCode, string message, Exception? inner = null)
        : base(message, inner)
    {
        RpcCode = rpcCode;
    }

    public int RpcCode { get; }
}

public static class RpcCodes
{
    public const int Network = -32001;
    public const int Timeout = -32002;
    public const int Auth = -32003;
    public const int RateLimit = -32004;
    public const int Server = -32005;
    public const int InvalidResponse = -32006;
    public const int Config = -32007;
}