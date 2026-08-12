namespace PolyPage.Gateway;

/// <summary>
/// Rolling file logger: %LocalAppData%\PolyPage\logs\gateway-yyyyMMdd.log,
/// files older than 7 days are deleted at startup (spec 2.0 §5.4 item 6).
/// Also mirrors to stderr which Native Messaging hosts may use for diagnostics.
/// </summary>
public sealed class GatewayLog : IDisposable
{
    private readonly object _lock = new();
    private StreamWriter? _writer;
    private string _currentDay = "";

    public static string LogDir => Path.Combine(GatewayConfig.InstallDir, "logs");

    public GatewayLog()
    {
        try
        {
            Directory.CreateDirectory(LogDir);
            PurgeOldLogs();
        }
        catch
        {
            // logging must never break the gateway
        }
    }

    private void PurgeOldLogs()
    {
        var cutoff = DateTime.Now.AddDays(-7);
        foreach (var file in Directory.GetFiles(LogDir, "gateway-*.log"))
        {
            try
            {
                if (File.GetLastWriteTime(file) < cutoff) File.Delete(file);
            }
            catch
            {
                // ignore
            }
        }
    }

    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        try
        {
            lock (_lock)
            {
                var day = DateTime.Now.ToString("yyyyMMdd");
                if (day != _currentDay || _writer is null)
                {
                    _writer?.Dispose();
                    _writer = new StreamWriter(
                        new FileStream(Path.Combine(LogDir, $"gateway-{day}.log"),
                            FileMode.Append, FileAccess.Write, FileShare.Read),
                        System.Text.Encoding.UTF8)
                    { AutoFlush = true };
                    _currentDay = day;
                }
                _writer.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {message}");
            }
        }
        catch
        {
            // never throw from logging
        }
        try
        {
            Console.Error.WriteLine($"[{level}] {message}");
        }
        catch
        {
            // ignore
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _writer = null;
        }
    }
}