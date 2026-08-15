using System.Text.Json;
using System.Text.Json.Nodes;
using PolyPage.Gateway.Backends;

namespace PolyPage.Gateway;

/// <summary>
/// Gateway configuration persisted at %LocalAppData%\PolyPage\gateway.json
/// (spec 2.0 §5.4 item 5). Sensitive fields are DPAPI-encrypted at rest.
/// </summary>
public sealed class GatewayConfig
{
    public string DefaultBackend { get; set; } = "";
    public List<OllamaBackendConfig> Ollama { get; set; } = new();
    public List<HttpBackendConfig> Http { get; set; } = new();
    public List<WhisperBackendConfig> Whisper { get; set; } = new();

    public static string InstallDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PolyPage");

    /// <summary>
    /// Config location; POLYPAGE_GATEWAY_CONFIG overrides it (used by the
    /// contract/smoke tests so the developer's real gateway.json is untouched).
    /// </summary>
    public static string ConfigPath =>
        Environment.GetEnvironmentVariable("POLYPAGE_GATEWAY_CONFIG") is { Length: > 0 } overridePath
            ? overridePath
            : Path.Combine(InstallDir, "gateway.json");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly HashSet<string> SensitiveNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "apiKey", "secret", "token", "password",
    };

    public static GatewayConfig CreateDefault()
    {
        return new GatewayConfig
        {
            DefaultBackend = "ollama",
            Ollama = new List<OllamaBackendConfig> { new() },
        };
    }

    public static async Task<GatewayConfig> LoadAsync()
    {
        if (!File.Exists(ConfigPath))
        {
            var fresh = CreateDefault();
            await SaveAsync(fresh);
            return fresh;
        }
        var raw = await File.ReadAllTextAsync(ConfigPath);
        var node = JsonNode.Parse(raw) ?? throw new InvalidDataException("gateway.json 为空");
        DecryptSecrets(node);
        return node.Deserialize<GatewayConfig>(JsonOptions) ?? CreateDefault();
    }

    public static async Task SaveAsync(GatewayConfig config)
    {
        Directory.CreateDirectory(InstallDir);
        var node = JsonSerializer.SerializeToNode(config, JsonOptions)
            ?? throw new InvalidOperationException("serialize failed");
        EncryptSecrets(node);
        await File.WriteAllTextAsync(ConfigPath, node.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true,
        }));
    }

    /* ------------------------------- DPAPI layer ------------------------------- */

    private static void EncryptSecrets(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToList())
            {
                if (property.Value is JsonValue value && value.TryGetValue(out string? s) && s is not null)
                {
                    if (SensitiveNames.Contains(property.Key) && !s.StartsWith("$enc:"))
                    {
                        obj[property.Key] = "$enc:" + SecretStore.Encrypt(s);
                    }
                }
                else if (property.Value is not null)
                {
                    EncryptSecrets(property.Value);
                }
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not null) EncryptSecrets(item);
            }
        }
    }

    private static void DecryptSecrets(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToList())
            {
                if (property.Value is JsonValue value && value.TryGetValue(out string? s) && s is not null)
                {
                    if (SensitiveNames.Contains(property.Key) && s.StartsWith("$enc:"))
                    {
                        obj[property.Key] = SecretStore.Decrypt(s[5..]);
                    }
                }
                else if (property.Value is not null)
                {
                    DecryptSecrets(property.Value);
                }
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not null) DecryptSecrets(item);
            }
        }
    }
}

/// <summary>DPAPI (CurrentUser scope) secret protection, Windows only.</summary>
public static class SecretStore
{
    public static string Encrypt(string plain)
    {
        if (!OperatingSystem.IsWindows()) return plain; // non-Windows dev fallback
        var bytes = System.Text.Encoding.UTF8.GetBytes(plain);
        var ProtectedData = System.Security.Cryptography.ProtectedData.Protect(
            bytes, null, System.Security.Cryptography.DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(ProtectedData);
    }

    public static string Decrypt(string encoded)
    {
        if (!OperatingSystem.IsWindows()) return encoded;
        var bytes = Convert.FromBase64String(encoded);
        var plain = System.Security.Cryptography.ProtectedData.Unprotect(
            bytes, null, System.Security.Cryptography.DataProtectionScope.CurrentUser);
        return System.Text.Encoding.UTF8.GetString(plain);
    }
}