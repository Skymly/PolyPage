using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PolyPage.Gateway.Backends;

namespace PolyPage.Gateway;

/// <summary>
/// JSON-RPC 2.0 dispatcher (spec 2.0 §5.2): ping / capabilities / translate /
/// translate.stream / cancel / backends.list / health.
///
/// Reads and writes run on independent tasks over a serialized write queue so
/// stdio never deadlocks (spec 2.0 §5.4 item 2).
/// </summary>
public sealed class GatewayServer
{
    public const string Name = "PolyPage Gateway";
    public const string Version = "4.2.0";
    public const int ProtocolVersion = 2;
    public const int DefaultMaxBinaryBytes = 32 * 1024 * 1024;

    private readonly IReadOnlyDictionary<string, IGatewayBackend> _backends;
    private readonly string _defaultBackendId;
    private readonly GatewayLog _log;
    private readonly Dictionary<long, CancellationTokenSource> _pending = new();
    private readonly Dictionary<string, BinaryTransfer> _transfers = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly int _maxBinaryBytes;

    private sealed class BinaryTransfer
    {
        public required string Mime { get; init; }
        public required int Total { get; init; }
        public string? Sha256 { get; set; }
        public Dictionary<int, byte[]> Parts { get; } = new();
        public byte[]? Assembled { get; set; }
    }

    public GatewayServer(IEnumerable<IGatewayBackend> backends, string defaultBackendId, GatewayLog log, int maxBinaryBytes = DefaultMaxBinaryBytes)
    {
        _backends = backends.ToDictionary(b => b.Id, b => b);
        _defaultBackendId = defaultBackendId;
        _log = log;
        _maxBinaryBytes = maxBinaryBytes > 0 ? maxBinaryBytes : DefaultMaxBinaryBytes;
    }

    public async Task RunAsync(Stream input, Stream output, CancellationToken ct)
    {
        _log.Info($"gateway started (version {Version}, backends: {string.Join(",", _backends.Keys)})");
        var handlers = new List<Task>();
        while (!ct.IsCancellationRequested)
        {
            byte[]? frame;
            try
            {
                frame = await NativeMessaging.ReadFrameAsync(input, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception e)
            {
                _log.Error($"frame read failed: {e.Message}");
                break;
            }
            if (frame is null) break; // stdin closed — browser terminated the host

            JsonRpcRequest request;
            try
            {
                request = JsonSerializer.Deserialize<JsonRpcRequest>(frame)
                    ?? throw new InvalidDataException("null request");
            }
            catch (Exception e)
            {
                await WriteAsync(output, JsonRpc.Fail(null, JsonRpc.ParseError, $"解析失败: {e.Message}"), ct);
                continue;
            }
            // Register the cancellation scope BEFORE dispatch so a `cancel`
            // arriving right after the request always finds it (spec §5.2).
            long requestId = request.Id is { } idEl && idEl.ValueKind == JsonValueKind.Number
                ? idEl.GetInt64()
                : 0;
            CancellationTokenSource? requestCts = null;
            if (!request.IsNotification && requestId != 0)
            {
                requestCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                lock (_pending) _pending[requestId] = requestCts;
            }

            // One task per request so streaming notifications and cancels
            // interleave freely; writes stay serialized. Tracked so RunAsync
            // can drain before returning (keeps contract tests deterministic).
            handlers.Add(Task.Run(() => HandleAsync(output, request, requestId, requestCts, ct), CancellationToken.None));
        }
        try
        {
            await Task.WhenAll(handlers);
        }
        catch
        {
            // individual handler failures already produced JSON-RPC errors
        }
        _log.Info("gateway exiting");
    }

    private async Task HandleAsync(
        Stream output,
        JsonRpcRequest request,
        long requestId,
        CancellationTokenSource? requestCts,
        CancellationToken globalCt)
    {
        var ct = requestCts?.Token ?? globalCt;
        try
        {
            var response = await DispatchAsync(request, requestId, output, ct);
            if (!request.IsNotification)
            {
                await WriteAsync(output, response, ct);
            }
        }
        catch (OperationCanceledException)
        {
            if (!request.IsNotification)
            {
                await WriteAsync(output,
                    JsonRpc.Fail(request.Id, RpcCodes.Timeout, "请求已取消"), ct);
            }
        }
        catch (GatewayBackendException e)
        {
            _log.Warn($"{request.Method} failed: [{e.RpcCode}] {e.Message}");
            if (!request.IsNotification)
            {
                await WriteAsync(output, JsonRpc.Fail(request.Id, e.RpcCode, e.Message), ct);
            }
        }
        catch (Exception e)
        {
            _log.Error($"{request.Method} crashed: {e}");
            if (!request.IsNotification)
            {
                await WriteAsync(output, JsonRpc.Fail(request.Id, JsonRpc.InternalError, e.Message), ct);
            }
        }
        finally
        {
            if (requestCts is not null)
            {
                lock (_pending) _pending.Remove(requestId);
                requestCts.Dispose();
            }
        }
    }

    private async Task<JsonRpcResponse> DispatchAsync(
        JsonRpcRequest request, long requestId, Stream output, CancellationToken ct)
    {
        switch (request.Method)
        {
            case "ping":
                return JsonRpc.Ok(request.Id, new
                {
                    protocol = ProtocolVersion,
                    name = Name,
                    version = Version,
                });

            case "capabilities":
            {
                var streaming = _backends.Values.Any(b => b.Capabilities.SupportsStreaming);
                var vision = _backends.Values.Any(b => b.Capabilities.SupportsVision);
                var asr = _backends.Values.Any(b => b.Capabilities.SupportsAsr);
                return JsonRpc.Ok(request.Id, new
                {
                    name = Name,
                    version = Version,
                    protocol = ProtocolVersion,
                    backends = _backends.Keys.ToArray(),
                    supportsStreaming = streaming,
                    supportsVision = vision,
                    supportsAsr = asr,
                    maxBinaryBytes = _maxBinaryBytes,
                    maxBatchItems = 50,
                    maxBatchChars = 20000,
                });
            }

            case "backends.list":
                return JsonRpc.Ok(request.Id, new
                {
                    backends = _backends.Values
                        .Select(b => new BackendInfo(b.Id, b.Name, b.Kind))
                        .ToArray(),
                });

            case "health":
            {
                var results = new List<object>();
                foreach (var backend in _backends.Values)
                {
                    var health = await backend.ProbeAsync(ct);
                    results.Add(new { id = backend.Id, kind = backend.Kind, ok = health.Ok, detail = health.Detail });
                }
                return JsonRpc.Ok(request.Id, new { backends = results });
            }

            case "translate":
                return await HandleTranslateAsync(request, requestId, output, ct);

            case "translate.stream":
                return await HandleTranslateStreamAsync(request, requestId, output, ct);

            case "cancel":
            {
                var targetId = GetLong(request.Params, "id");
                if (targetId is { } tid)
                {
                    CancellationTokenSource? cts;
                    lock (_pending) _pending.TryGetValue(tid, out cts);
                    cts?.Cancel();
                }
                return JsonRpc.Ok(request.Id, new { ok = true });
            }

            case "binary.chunk":
                return HandleBinaryChunk(request);

            case "translate.image":
                return await HandleTranslateImageAsync(request, ct);

            case "transcribe":
                return await HandleTranscribeAsync(request, ct);

            default:
                throw new GatewayBackendException(JsonRpc.MethodNotFound, $"未知方法: {request.Method}");
        }
    }

    private IGatewayBackend ResolveBackend(JsonElement? paramsElement)
    {
        var requested = GetString(paramsElement, "backend");
        var id = string.IsNullOrWhiteSpace(requested) ? _defaultBackendId : requested;
        if (!_backends.TryGetValue(id, out var backend))
        {
            throw new GatewayBackendException(RpcCodes.Config,
                $"未知后端 \"{id}\"（可用: {string.Join(", ", _backends.Keys)}）");
        }
        return backend;
    }

    private async Task<JsonRpcResponse> HandleTranslateAsync(
        JsonRpcRequest request, long requestId, Stream output, CancellationToken ct)
    {
        var backend = ResolveBackend(request.Params);
        var texts = GetStringArray(request.Params, "texts")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "translate 需要 texts 数组");
        var source = GetString(request.Params, "source") ?? "auto";
        var target = GetString(request.Params, "target") ?? "zh-CN";

        ValidateBatch(backend, texts);

        var ctx = new TranslateContext(source, target);
        var translated = await backend.TranslateAsync(texts, ctx, ct);
        return JsonRpc.Ok(request.Id, new { translations = translated, backend = backend.Id });
    }

    private async Task<JsonRpcResponse> HandleTranslateStreamAsync(
        JsonRpcRequest request, long requestId, Stream output, CancellationToken ct)
    {
        var backend = ResolveBackend(request.Params);
        var text = GetString(request.Params, "text")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "translate.stream 需要 text");
        var source = GetString(request.Params, "source") ?? "auto";
        var target = GetString(request.Params, "target") ?? "zh-CN";

        var ctx = new TranslateContext(source, target);
        var stream = backend.StreamAsync(text, ctx, ct);
        if (stream is null)
        {
            // Fallback: one-shot translate returned as a single delta.
            var single = await backend.TranslateAsync(new[] { text }, ctx, ct);
            var full = single.Length > 0 ? single[0] : "";
            await WriteAsync(output, null, ct, notification: ("translate.delta", new { id = requestId, delta = full }));
            return JsonRpc.Ok(request.Id, new { translation = full, backend = backend.Id });
        }

        var accumulated = new StringBuilder();
        await foreach (var delta in stream.WithCancellation(ct))
        {
            accumulated.Append(delta);
            await WriteAsync(output, null, ct, notification: ("translate.delta", new { id = requestId, delta }));
        }
        return JsonRpc.Ok(request.Id, new { translation = accumulated.ToString(), backend = backend.Id });
    }

    private JsonRpcResponse HandleBinaryChunk(JsonRpcRequest request)
    {
        var transferId = GetString(request.Params, "transferId")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "binary.chunk 需要 transferId");
        var index = GetInt(request.Params, "index")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "binary.chunk 需要 index");
        var total = GetInt(request.Params, "total")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "binary.chunk 需要 total");
        var mime = GetString(request.Params, "mime") ?? "application/octet-stream";
        var data = GetString(request.Params, "data") ?? "";
        var sha256 = GetString(request.Params, "sha256");
        if (total <= 0 || index < 0 || index >= total)
        {
            throw new GatewayBackendException(RpcCodes.Config, "binary.chunk 的 index/total 无效");
        }
        byte[] part;
        try
        {
            part = Convert.FromBase64String(data);
        }
        catch (FormatException)
        {
            throw new GatewayBackendException(RpcCodes.Config, "binary.chunk data 不是合法 Base64");
        }

        BinaryTransfer transfer;
        lock (_transfers)
        {
            if (!_transfers.TryGetValue(transferId, out transfer!))
            {
                transfer = new BinaryTransfer { Mime = mime, Total = total };
                _transfers[transferId] = transfer;
            }
            if (transfer.Total != total)
            {
                throw new GatewayBackendException(RpcCodes.Config, "binary.chunk total 与已有传输不一致");
            }
            transfer.Parts[index] = part;
            if (!string.IsNullOrWhiteSpace(sha256)) transfer.Sha256 = sha256;
            if (transfer.Parts.Count < transfer.Total)
            {
                return JsonRpc.Ok(request.Id, new { transferId, received = transfer.Parts.Count, total = transfer.Total, complete = false });
            }
            var assembled = new byte[transfer.Parts.OrderBy(p => p.Key).Sum(p => p.Value.Length)];
            var offset = 0;
            foreach (var kv in transfer.Parts.OrderBy(p => p.Key))
            {
                Buffer.BlockCopy(kv.Value, 0, assembled, offset, kv.Value.Length);
                offset += kv.Value.Length;
            }
            if (assembled.Length > _maxBinaryBytes)
            {
                _transfers.Remove(transferId);
                throw new GatewayBackendException(RpcCodes.Config,
                    $"拼装后二进制超过上限（{assembled.Length} > {_maxBinaryBytes}）");
            }
            if (!string.IsNullOrWhiteSpace(transfer.Sha256))
            {
                var hex = Convert.ToHexString(SHA256.HashData(assembled)).ToLowerInvariant();
                if (!string.Equals(hex, transfer.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    _transfers.Remove(transferId);
                    throw new GatewayBackendException(RpcCodes.Config, "binary.chunk sha256 校验失败");
                }
            }
            transfer.Assembled = assembled;
            transfer.Parts.Clear();
            return JsonRpc.Ok(request.Id, new
            {
                transferId,
                received = total,
                total,
                complete = true,
                bytes = assembled.Length,
                sha256 = transfer.Sha256 ?? Convert.ToHexString(SHA256.HashData(assembled)).ToLowerInvariant(),
                mime = transfer.Mime,
            });
        }
    }

    private async Task<JsonRpcResponse> HandleTranslateImageAsync(JsonRpcRequest request, CancellationToken ct)
    {
        var backend = ResolveBackend(request.Params);
        var (bytes, mime) = ResolveImagePayload(request.Params);
        var source = GetString(request.Params, "source") ?? "auto";
        var target = GetString(request.Params, "target") ?? "zh-CN";
        var result = await backend.TranslateImageAsync(bytes, mime, new TranslateContext(source, target), ct);
        if (result is null)
        {
            throw new GatewayBackendException(RpcCodes.Config, $"后端 \"{backend.Id}\" 不支持视觉翻译");
        }
        return JsonRpc.Ok(request.Id, new
        {
            segments = result.Segments.Select(s => new { text = s.Text, translation = s.Translation }).ToArray(),
            backend = backend.Id,
        });
    }

    private async Task<JsonRpcResponse> HandleTranscribeAsync(JsonRpcRequest request, CancellationToken ct)
    {
        var backend = ResolveBackend(request.Params);
        var transferId = GetString(request.Params, "transferId")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "transcribe 需要 transferId（音频必须分块上传）");
        if (GetString(request.Params, "dataUrl") is not null)
        {
            throw new GatewayBackendException(JsonRpc.InvalidParams, "transcribe 不接受内联音频");
        }
        var (bytes, mime) = TakeTransfer(transferId);
        var source = GetString(request.Params, "source") ?? "auto";
        var target = GetString(request.Params, "target") ?? "zh-CN";
        var hint = GetString(request.Params, "languageHint");
        var ctx = new TranslateContext(hint ?? source, target);
        var result = await backend.TranscribeAsync(bytes, mime, ctx, ct);
        if (result is null)
        {
            throw new GatewayBackendException(RpcCodes.Config, $"后端 \"{backend.Id}\" 不支持转写");
        }
        return JsonRpc.Ok(request.Id, new
        {
            text = result.Text,
            segments = result.Segments?.Select(s => new { start = s.Start, end = s.End, text = s.Text }).ToArray(),
            backend = backend.Id,
        });
    }

    private (byte[] bytes, string mime) ResolveImagePayload(JsonElement? paramsElement)
    {
        var transferId = GetString(paramsElement, "transferId");
        if (!string.IsNullOrWhiteSpace(transferId)) return TakeTransfer(transferId);
        var dataUrl = GetString(paramsElement, "dataUrl")
            ?? throw new GatewayBackendException(JsonRpc.InvalidParams, "translate.image 需要 transferId 或 dataUrl");
        return DecodeDataUrl(dataUrl);
    }

    private (byte[] bytes, string mime) TakeTransfer(string transferId)
    {
        lock (_transfers)
        {
            if (!_transfers.TryGetValue(transferId, out var transfer) || transfer.Assembled is null)
            {
                throw new GatewayBackendException(RpcCodes.Config, $"未知或未完成的 transferId: {transferId}");
            }
            var bytes = transfer.Assembled;
            var mime = transfer.Mime;
            _transfers.Remove(transferId);
            return (bytes, mime);
        }
    }

    private (byte[] bytes, string mime) DecodeDataUrl(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        var header = comma >= 0 ? dataUrl[..comma] : "";
        var payload = comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl;
        var mime = "image/png";
        var start = header.IndexOf(':');
        var end = header.IndexOf(';');
        if (start >= 0 && end > start) mime = header[(start + 1)..end];
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(payload);
        }
        catch (FormatException)
        {
            throw new GatewayBackendException(RpcCodes.Config, "dataUrl 不是合法 Base64");
        }
        if (bytes.Length > _maxBinaryBytes)
        {
            throw new GatewayBackendException(RpcCodes.Config, $"内联图片超过上限（{bytes.Length} > {_maxBinaryBytes}）");
        }
        return (bytes, mime);
    }

    private static void ValidateBatch(IGatewayBackend backend, IReadOnlyList<string> texts)
    {
        var caps = backend.Capabilities;
        if (texts.Count > caps.MaxBatchItems)
        {
            throw new GatewayBackendException(RpcCodes.Config,
                $"批量超过后端上限（{texts.Count} > {caps.MaxBatchItems} 条），请在扩展侧预切分");
        }
        var chars = texts.Sum(t => t.Length);
        if (chars > caps.MaxBatchChars)
        {
            throw new GatewayBackendException(RpcCodes.Config,
                $"批量字符数超过后端上限（{chars} > {caps.MaxBatchChars}），请在扩展侧预切分");
        }
    }

    private async Task WriteAsync(
        Stream output,
        JsonRpcResponse? response,
        CancellationToken ct,
        (string method, object payload)? notification = null)
    {
        await _writeLock.WaitAsync(CancellationToken.None);
        try
        {
            byte[] payload;
            if (notification is { } n)
            {
                payload = JsonSerializer.SerializeToUtf8Bytes(new
                {
                    jsonrpc = "2.0",
                    method = n.method,
                    @params = n.payload,
                }, JsonRpc.Options);
            }
            else
            {
                payload = JsonRpc.SerializeResponse(response!);
            }
            await NativeMessaging.WriteFrameAsync(output, payload, CancellationToken.None);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /* ------------------------------- param helpers ------------------------------ */

    private static string? GetString(JsonElement? element, string name)
    {
        if (element is not { } el || el.ValueKind != JsonValueKind.Object) return null;
        return el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
    }

    private static int? GetInt(JsonElement? element, string name)
    {
        if (element is not { } el || el.ValueKind != JsonValueKind.Object) return null;
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Number) return null;
        if (v.TryGetInt32(out var i)) return i;
        return (int)v.GetInt64();
    }

    private static long? GetLong(JsonElement? element, string name)
    {
        if (element is not { } el || el.ValueKind != JsonValueKind.Object) return null;
        return el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetInt64()
            : null;
    }

    private static List<string>? GetStringArray(JsonElement? element, string name)
    {
        if (element is not { } el || el.ValueKind != JsonValueKind.Object) return null;
        if (!el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) return null;
        var list = new List<string>();
        foreach (var item in v.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) return null;
            list.Add(item.GetString() ?? "");
        }
        return list;
    }
}