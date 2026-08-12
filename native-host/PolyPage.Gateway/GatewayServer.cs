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
    public const string Version = "2.0.0";
    public const int ProtocolVersion = 1;

    private readonly IReadOnlyDictionary<string, IGatewayBackend> _backends;
    private readonly string _defaultBackendId;
    private readonly GatewayLog _log;
    private readonly Dictionary<long, CancellationTokenSource> _pending = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public GatewayServer(IEnumerable<IGatewayBackend> backends, string defaultBackendId, GatewayLog log)
    {
        _backends = backends.ToDictionary(b => b.Id, b => b);
        _defaultBackendId = defaultBackendId;
        _log = log;
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
            // One task per request so streaming notifications and cancels
            // interleave freely; writes stay serialized. Tracked so RunAsync
            // can drain before returning (keeps contract tests deterministic).
            handlers.Add(Task.Run(() => HandleAsync(output, request, ct), CancellationToken.None));
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

    private async Task HandleAsync(Stream output, JsonRpcRequest request, CancellationToken ct)
    {
        long requestId = request.Id is { } idElem && idElem.ValueKind == JsonValueKind.Number
            ? idElem.GetInt64()
            : 0;
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
            lock (_pending) _pending.Remove(requestId);
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
                return JsonRpc.Ok(request.Id, new
                {
                    name = Name,
                    version = Version,
                    protocol = ProtocolVersion,
                    backends = _backends.Keys.ToArray(),
                    supportsStreaming = streaming,
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

        using var requestCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lock (_pending) _pending[requestId] = requestCts;

        var ctx = new TranslateContext(source, target);
        var translated = await backend.TranslateAsync(texts, ctx, requestCts.Token);
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

        using var requestCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lock (_pending) _pending[requestId] = requestCts;

        var ctx = new TranslateContext(source, target);
        var stream = backend.StreamAsync(text, ctx, requestCts.Token);
        if (stream is null)
        {
            // Fallback: one-shot translate returned as a single delta.
            var single = await backend.TranslateAsync(new[] { text }, ctx, requestCts.Token);
            var full = single.Length > 0 ? single[0] : "";
            await WriteAsync(output, null, ct, notification: ("translate.delta", new { id = requestId, delta = full }));
            return JsonRpc.Ok(request.Id, new { translation = full, backend = backend.Id });
        }

        var accumulated = new StringBuilder();
        await foreach (var delta in stream.WithCancellation(requestCts.Token))
        {
            accumulated.Append(delta);
            await WriteAsync(output, null, ct, notification: ("translate.delta", new { id = requestId, delta }));
        }
        return JsonRpc.Ok(request.Id, new { translation = accumulated.ToString(), backend = backend.Id });
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