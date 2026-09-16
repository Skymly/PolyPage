using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace PolyPage.Gateway;

/// <summary>
/// Windows installer (spec 2.0 §5.5): the gateway binary doubles as its own
/// installer via --install / --uninstall / --status subcommands.
///
///  - copies the gateway exe to %LocalAppData%\PolyPage\;
///  - writes the Native Messaging host manifest;
///  - registers HKCU NativeMessagingHosts keys for Chrome and Edge (no admin);
///  - --allow origin replaces allowed_origins after format validation (M-75).
/// </summary>
public static class Installer
{
    public const string DefaultHostName = "com.skymly.polypage.gateway";

    public const string DefaultGeckoId = "polypage@skymly.com";

    /// <summary>Chrome/Edge Native Messaging origin: chrome-extension://id/ (M-75).</summary>
    private static readonly Regex ChromeExtensionOrigin =
        new(@"^chrome-extension://[a-z0-9._-]+/$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly string[] BrowserRegistryRoots =
    {
        @"Software\Google\Chrome\NativeMessagingHosts",
        @"Software\Microsoft\Edge\NativeMessagingHosts",
    };

    private const string MozillaRegistryRoot = @"Software\Mozilla\NativeMessagingHosts";

    public static string HostName { get; set; } = DefaultHostName;

    private static string InstallDir => GatewayConfig.InstallDir;
    private static string InstalledExe => Path.Combine(InstallDir, InstalledExecutableFileName(HostName));
    private static string ManifestPath => Path.Combine(InstallDir, $"{HostName}.json");
    private static string FirefoxManifestPath => Path.Combine(InstallDir, $"{HostName}.firefox.json");

    /// <summary>
    /// Default host keeps the historical exe name. Other host names (smoke, side-by-side)
    /// get their own file so --install cannot overwrite a production gateway.
    /// </summary>
    public static string InstalledExecutableFileName(string hostName) =>
        string.Equals(hostName, DefaultHostName, StringComparison.OrdinalIgnoreCase)
            ? "PolyPage.Gateway.exe"
            : $"{hostName}.exe";

    public static bool IsChromeExtensionOrigin(string origin) =>
        !string.IsNullOrWhiteSpace(origin) && ChromeExtensionOrigin.IsMatch(origin.Trim());

    /// <summary>
    /// Non-empty --allow replaces the stored list; otherwise existing origins are kept (M-75).
    /// </summary>
    public static List<string> ResolveOrigins(IReadOnlyList<string> existing, string[] allowOrigins)
    {
        if (allowOrigins.Length > 0)
        {
            return allowOrigins
                .Select(o => o.Trim())
                .Where(o => o.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        return existing.ToList();
    }

    public static Dictionary<string, object> ChromiumManifest(
        string hostName,
        string exePath,
        IReadOnlyList<string> origins) => new()
    {
        ["name"] = hostName,
        ["description"] = "PolyPage local translation gateway",
        ["path"] = exePath,
        ["type"] = "stdio",
        ["allowed_origins"] = origins,
    };

    public static Dictionary<string, object> FirefoxManifest(
        string hostName,
        string exePath,
        IReadOnlyList<string> geckoIds) => new()
    {
        ["name"] = hostName,
        ["description"] = "PolyPage local translation gateway",
        ["path"] = exePath,
        ["type"] = "stdio",
        ["allowed_extensions"] = geckoIds,
    };

    public static bool RemovesGatewayConfig(string hostName) =>
        string.Equals(hostName, DefaultHostName, StringComparison.OrdinalIgnoreCase);

    public static int Install(string[] allowOrigins, string[]? allowGeckoIds = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("安装器目前仅支持 Windows。");
            return 1;
        }

        foreach (var origin in allowOrigins)
        {
            if (!IsChromeExtensionOrigin(origin))
            {
                Console.Error.WriteLine($"非法 allowed origin（需要 chrome-extension://<id>/）：{origin}");
                return 1;
            }
        }

        Directory.CreateDirectory(InstallDir);

        // 1. Copy the gateway binary into the install dir (unless it is the
        //    same file already, e.g. re-running from the install location).
        var current = Environment.ProcessPath ?? "";
        if (!PathsEqual(current, InstalledExe))
        {
            File.Copy(current, InstalledExe, overwrite: true);
            Console.WriteLine($"已复制网关: {InstalledExe}");
        }
        else
        {
            Console.WriteLine($"网关已在安装位置: {InstalledExe}");
        }

        // 2. Chromium manifest: allowed_origins only. Firefox uses a sibling file.
        var storedOrigins = new List<string>();
        if (File.Exists(ManifestPath))
        {
            try
            {
                var existing = JsonDocument.Parse(File.ReadAllText(ManifestPath));
                if (existing.RootElement.TryGetProperty("allowed_origins", out var arr) &&
                    arr.ValueKind == JsonValueKind.Array)
                {
                    storedOrigins.AddRange(arr.EnumerateArray()
                        .Where(e => e.ValueKind == JsonValueKind.String)
                        .Select(e => e.GetString()!));
                }
            }
            catch
            {
                // corrupted manifest — rebuild
            }
        }
        var origins = ResolveOrigins(storedOrigins, allowOrigins);

        var storedGecko = new List<string>();
        if (File.Exists(FirefoxManifestPath))
        {
            try
            {
                var existingFx = JsonDocument.Parse(File.ReadAllText(FirefoxManifestPath));
                if (existingFx.RootElement.TryGetProperty("allowed_extensions", out var fxArr) &&
                    fxArr.ValueKind == JsonValueKind.Array)
                {
                    storedGecko.AddRange(fxArr.EnumerateArray()
                        .Where(e => e.ValueKind == JsonValueKind.String)
                        .Select(e => e.GetString()!));
                }
            }
            catch
            {
                /* rebuild */
            }
        }
        var geckoIds = allowGeckoIds is { Length: > 0 }
            ? allowGeckoIds.Select(id => id.Trim()).Where(id => id.Length > 0).Distinct().ToList()
            : storedGecko;
        if (geckoIds.Count == 0) geckoIds.Add(DefaultGeckoId);

        var jsonOptions = new JsonSerializerOptions { WriteIndented = true };
        File.WriteAllText(ManifestPath, JsonSerializer.Serialize(
            ChromiumManifest(HostName, InstalledExe, origins), jsonOptions));
        Console.WriteLine($"已写入 host manifest: {ManifestPath}");
        File.WriteAllText(FirefoxManifestPath, JsonSerializer.Serialize(
            FirefoxManifest(HostName, InstalledExe, geckoIds), jsonOptions));
        Console.WriteLine($"已写入 Firefox host manifest: {FirefoxManifestPath}");
        if (origins.Count == 0)
        {
            Console.WriteLine("警告: allowed_origins 为空。请用 --allow chrome-extension://<id>/ 指定扩展来源。");
        }

        // 3. Registry entries (HKCU — no elevation required).
        foreach (var root in BrowserRegistryRoots)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey($@"{root}\{HostName}");
                key.SetValue(null, ManifestPath);
                Console.WriteLine($"已注册: HKCU\\{root}\\{HostName}");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"注册 {root} 失败: {e.Message}");
            }
        }
        try
        {
            using var fxKey = Registry.CurrentUser.CreateSubKey($@"{MozillaRegistryRoot}\{HostName}");
            fxKey.SetValue(null, FirefoxManifestPath);
            Console.WriteLine($"已注册: HKCU\\{MozillaRegistryRoot}\\{HostName}");
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"注册 Mozilla NativeMessagingHosts 失败: {e.Message}");
        }

        Console.WriteLine("安装完成。请在浏览器扩展管理页重新加载扩展后测试连接。");
        return 0;
    }

    public static int Uninstall()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("安装器目前仅支持 Windows。");
            return 1;
        }
        foreach (var root in BrowserRegistryRoots)
        {
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree($@"{root}\{HostName}", throwOnMissingSubKey: false);
                Console.WriteLine($"已移除注册表项: HKCU\\{root}\\{HostName}");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"移除 {root} 失败: {e.Message}");
            }
        }
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree($@"{MozillaRegistryRoot}\{HostName}", throwOnMissingSubKey: false);
            Console.WriteLine($"已移除注册表项: HKCU\\{MozillaRegistryRoot}\\{HostName}");
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"移除 Mozilla 键失败: {e.Message}");
        }
        try
        {
            if (File.Exists(ManifestPath)) File.Delete(ManifestPath);
            if (File.Exists(FirefoxManifestPath)) File.Delete(FirefoxManifestPath);
            if (File.Exists(InstalledExe)) File.Delete(InstalledExe);
            if (RemovesGatewayConfig(HostName)
                && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("POLYPAGE_GATEWAY_CONFIG"))
                && File.Exists(GatewayConfig.ConfigPath))
            {
                File.Delete(GatewayConfig.ConfigPath);
                Console.WriteLine("已移除 gateway.json。");
            }
            Console.WriteLine("已移除 manifest 与网关文件（日志目录保留）。");
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"移除文件失败: {e.Message}");
        }
        return 0;
    }

    public static int Status()
    {
        Console.WriteLine($"host name : {HostName}");
        Console.WriteLine($"manifest  : {(File.Exists(ManifestPath) ? ManifestPath : "未安装")}");
        Console.WriteLine($"exe       : {(File.Exists(InstalledExe) ? InstalledExe : "未安装")}");
        if (OperatingSystem.IsWindows())
        {
            foreach (var root in BrowserRegistryRoots)
            {
                using var key = Registry.CurrentUser.OpenSubKey($@"{root}\{HostName}");
                var value = key?.GetValue(null) as string;
                Console.WriteLine($"registry  : HKCU\\{root}\\{HostName} = {value ?? "（未注册）"}");
            }
            using (var fxKey = Registry.CurrentUser.OpenSubKey($@"{MozillaRegistryRoot}\{HostName}"))
            {
                var fxValue = fxKey?.GetValue(null) as string;
                Console.WriteLine($"registry  : HKCU\\{MozillaRegistryRoot}\\{HostName} = {fxValue ?? "（未注册）"}");
            }
            Console.WriteLine($"firefox   : {(File.Exists(FirefoxManifestPath) ? FirefoxManifestPath : "未安装")}");
        }
        return File.Exists(ManifestPath) && File.Exists(InstalledExe) ? 0 : 1;
    }

    private static bool PathsEqual(string a, string b)
    {
        try
        {
            return Path.GetFullPath(a).Equals(Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}
