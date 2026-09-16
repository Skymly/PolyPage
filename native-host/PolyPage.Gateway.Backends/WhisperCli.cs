using System.Diagnostics;
using System.Text;

namespace PolyPage.Gateway.Backends;

/// <summary>whisper.cpp CLI spawn helper (M-15): quoted ArgumentList, concurrent stdio, timeout, Kill.</summary>
public static class WhisperCli
{
    public static (string FileName, string[] Arguments) SplitCommandLine(string command)
    {
        var parts = new List<string>();
        var sb = new StringBuilder();
        var inQuote = false;
        foreach (var c in command)
        {
            if (c == '"')
            {
                inQuote = !inQuote;
                continue;
            }
            if (!inQuote && char.IsWhiteSpace(c))
            {
                if (sb.Length > 0)
                {
                    parts.Add(sb.ToString());
                    sb.Clear();
                }
                continue;
            }
            sb.Append(c);
        }
        if (sb.Length > 0) parts.Add(sb.ToString());
        if (parts.Count == 0)
            throw new GatewayBackendException(RpcCodes.Config, "whisper.cpp command 为空");
        return (parts[0], parts.Skip(1).ToArray());
    }

    public static ProcessStartInfo CreateStartInfo(string command)
    {
        var (file, args) = SplitCommandLine(command);
        var psi = new ProcessStartInfo
        {
            FileName = file,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
            psi.ArgumentList.Add(arg);
        return psi;
    }

    public static async Task<(int ExitCode, string Stdout, string Stderr)> RunAsync(
        ProcessStartInfo psi, int timeoutMs, CancellationToken ct)
    {
        System.Diagnostics.Process proc;
        try
        {
            proc = System.Diagnostics.Process.Start(psi)
                ?? throw new GatewayBackendException(RpcCodes.Config, "无法启动 whisper.cpp 命令");
        }
        catch (Exception e) when (e is not GatewayBackendException)
        {
            throw new GatewayBackendException(RpcCodes.Config, $"无法启动 whisper.cpp：{e.Message}", e);
        }

        using (proc)
        {
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            if (timeoutMs > 0) timeoutCts.CancelAfter(timeoutMs);
            try
            {
                await proc.WaitForExitAsync(timeoutCts.Token);
            }
            catch (OperationCanceledException)
            {
                TryKill(proc);
                try { await Task.WhenAll(stdoutTask, stderrTask); } catch { /* killed */ }
                if (!ct.IsCancellationRequested)
                    throw new GatewayBackendException(RpcCodes.Timeout, $"Whisper CLI 超时（{timeoutMs}ms）");
                throw new GatewayBackendException(RpcCodes.Aborted, "Whisper CLI 已取消");
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            return (proc.ExitCode, stdout, stderr);
        }
    }

    private static void TryKill(System.Diagnostics.Process proc)
    {
        try
        {
            if (!proc.HasExited)
                proc.Kill(entireProcessTree: true);
            proc.WaitForExit(2000);
        }
        catch
        {
            /* already gone */
        }
    }
}
