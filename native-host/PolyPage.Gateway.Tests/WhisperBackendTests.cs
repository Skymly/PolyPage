using System.Diagnostics;
using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

/// <summary>M-15: Whisper CLI ArgumentList, concurrent stdio, timeout, Kill.</summary>
public class WhisperBackendTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "whisper test " + Guid.NewGuid().ToString("N"));

    public WhisperBackendTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* temp */ }
    }

    private static string NodeExe()
    {
        var pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(pf)) return pf;
        throw new InvalidOperationException("node.exe with a space in the path is required for M-15");
    }

    private WhisperBackend Cli(string scriptName, string scriptBody, int timeoutMs = 15_000, string extraQuotedArg = "")
    {
        var script = Path.Combine(_dir, scriptName);
        File.WriteAllText(script, scriptBody);
        var command = $"\"{NodeExe()}\" \"{script}\"";
        if (!string.IsNullOrEmpty(extraQuotedArg))
            command += $" \"{extraQuotedArg}\"";
        return new WhisperBackend(new WhisperBackendConfig
        {
            Id = "whisper-cli",
            Command = command,
            TimeoutMs = timeoutMs,
        });
    }

    [Fact]
    public async Task QuotedPathWithSpacesStartsNodeAndParsesJson()
    {
        var backend = Cli("echo.mjs", "process.stdout.write(JSON.stringify({text:'hello from cli'}));");
        var result = await backend.TranscribeAsync(new byte[] { 1, 2, 3 }, "audio/webm", new TranslateContext("en", "zh"), CancellationToken.None);
        Assert.Equal("hello from cli", result?.Text);
    }

    [Fact]
    public async Task ConcurrentStderrFloodDoesNotDeadlock()
    {
        var backend = Cli(
            "flood.mjs",
            "process.stderr.write('x'.repeat(2_000_000)); process.stdout.write(JSON.stringify({text:'ok'}));",
            timeoutMs: 10_000);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        var result = await backend.TranscribeAsync(new byte[] { 1 }, "audio/webm", new TranslateContext("en", "zh"), cts.Token);
        Assert.Equal("ok", result?.Text);
    }

    [Fact]
    public async Task TimeoutKillsTheChildProcess()
    {
        var pidFile = Path.Combine(_dir, "hang.pid");
        var backend = Cli(
            "hang.cjs",
            "const fs=require('fs'); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(()=>{}, 1000);\n",
            timeoutMs: 1500,
            extraQuotedArg: pidFile);
        var err = await Assert.ThrowsAsync<GatewayBackendException>(
            () => backend.TranscribeAsync(new byte[] { 1 }, "audio/webm", new TranslateContext("en", "zh"), CancellationToken.None));
        Assert.Equal(RpcCodes.Timeout, err.RpcCode);
        await Task.Delay(200);
        Assert.True(File.Exists(pidFile));
        var pid = int.Parse(File.ReadAllText(pidFile));
        Assert.True(ProcessGone(pid));
    }

    [Fact]
    public async Task CancelKillsTheChildProcess()
    {
        var pidFile = Path.Combine(_dir, "cancel.pid");
        var backend = Cli(
            "cancel.cjs",
            "const fs=require('fs'); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(()=>{}, 1000);\n",
            timeoutMs: 30_000,
            extraQuotedArg: pidFile);
        using var cts = new CancellationTokenSource();
        var task = backend.TranscribeAsync(new byte[] { 1 }, "audio/webm", new TranslateContext("en", "zh"), cts.Token);
        await WaitForFile(pidFile, TimeSpan.FromSeconds(5));
        var pid = int.Parse(File.ReadAllText(pidFile));
        cts.Cancel();
        var err = await Assert.ThrowsAsync<GatewayBackendException>(() => task);
        Assert.Equal(RpcCodes.Aborted, err.RpcCode);
        await Task.Delay(200);
        Assert.True(ProcessGone(pid));
    }

    [Fact]
    public void SplitCommandLineKeepsQuotedExecutableWithSpaces()
    {
        var (file, args) = WhisperCli.SplitCommandLine("\"C:\\Program Files\\whisper\\main.exe\" -m model -f input.wav");
        Assert.Equal(@"C:\Program Files\whisper\main.exe", file);
        Assert.Equal(new[] { "-m", "model", "-f", "input.wav" }, args);
    }

    private static async Task WaitForFile(string path, TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            if (File.Exists(path) && new FileInfo(path).Length > 0) return;
            await Task.Delay(20);
        }
        throw new TimeoutException("pid file was not written");
    }

    private static bool ProcessGone(int pid)
    {
        try
        {
            var proc = Process.GetProcessById(pid);
            return proc.HasExited;
        }
        catch (ArgumentException)
        {
            return true;
        }
    }
}
