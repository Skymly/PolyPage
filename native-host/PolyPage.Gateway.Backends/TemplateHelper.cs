using System.Text.Json;

namespace PolyPage.Gateway.Backends;

/// <summary>Template/response helpers shared by backends.</summary>
public static class TemplateHelper
{
    /// <summary>Replace {{var}} placeholders; unknown variables are kept.</summary>
    public static string Render(string template, IReadOnlyDictionary<string, string> vars)
    {
        return System.Text.RegularExpressions.Regex.Replace(
            template,
            @"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}",
            m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : m.Value);
    }

    /// <summary>Escape a value for embedding inside a JSON string literal.</summary>
    public static string EscapeForJson(string value)
    {
        var encoded = JsonSerializer.Serialize(value);
        // Strip the surrounding quotes added by Serialize.
        return encoded[1..^1];
    }

    /// <summary>Walk a dot path ("data.translations.0.text") into a JSON element.</summary>
    public static JsonElement? GetByPath(JsonElement root, string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return root;
        var current = root;
        foreach (var rawSegment in path.Split('.'))
        {
            var segment = rawSegment.Trim();
            if (segment.Length == 0) continue;
            switch (current.ValueKind)
            {
                case JsonValueKind.Object:
                    if (!current.TryGetProperty(segment, out var next)) return null;
                    current = next;
                    break;
                case JsonValueKind.Array:
                    if (!int.TryParse(segment, out var index)) return null;
                    if (index < 0 || index >= current.GetArrayLength()) return null;
                    current = current[index];
                    break;
                default:
                    return null;
            }
        }
        return current;
    }

    private static readonly string[] ObjectTextKeys = { "translation", "translatedText", "text", "target", "result" };

    /// <summary>Extract a list of translated strings from a JSON value.</summary>
    public static List<string>? ExtractStrings(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var s = value.GetString() ?? "";
            return s.Trim().Length == 0 ? null : new List<string> { s };
        }
        if (value.ValueKind != JsonValueKind.Array) return null;
        var result = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                result.Add(item.GetString() ?? "");
            }
            else if (item.ValueKind == JsonValueKind.Object)
            {
                string? found = null;
                foreach (var key in ObjectTextKeys)
                {
                    if (item.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                    {
                        found = v.GetString();
                        break;
                    }
                }
                if (found is null) return null;
                result.Add(found);
            }
            else
            {
                return null;
            }
        }
        return result;
    }

    /// <summary>
    /// Parse a model reply for a batch of N texts (mirrors the extension's
    /// parseBatchTranslation): JSON array, numbered list, or the whole reply
    /// when N == 1.
    /// </summary>
    public static string[]? ParseBatchTranslation(string content, int expectedCount)
    {
        var cleaned = StripCodeFences(content).Trim();
        if (cleaned.Length == 0) return null;
        if (expectedCount == 1) return new[] { cleaned };

        var start = cleaned.IndexOf('[');
        var end = cleaned.LastIndexOf(']');
        if (start >= 0 && end > start)
        {
            try
            {
                using var doc = JsonDocument.Parse(cleaned[start..(end + 1)]);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    var arr = doc.RootElement.EnumerateArray()
                        .Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : null)
                        .ToList();
                    if (arr.Count == expectedCount && arr.All(x => x is not null))
                    {
                        return arr.Cast<string>().ToArray();
                    }
                }
            }
            catch (JsonException)
            {
                // fall through to numbered list parsing
            }
        }

        var items = new List<string>();
        var buffer = new List<string>();
        var lastNumber = 0;
        foreach (var line in cleaned.Split('\n'))
        {
            var m = System.Text.RegularExpressions.Regex.Match(line, @"^\s*(?:\[(\d+)\]|(\d+)[.)、])\s*(.*)$");
            if (m.Success)
            {
                if (buffer.Count > 0) items.Add(string.Join("\n", buffer).Trim());
                buffer.Clear();
                var n = int.Parse(string.IsNullOrEmpty(m.Groups[1].Value) ? m.Groups[2].Value : m.Groups[1].Value);
                if (n != lastNumber + 1 && lastNumber != 0 && items.Count > 0) return null;
                lastNumber = n;
                buffer.Add(m.Groups[3].Value);
            }
            else if (lastNumber > 0)
            {
                buffer.Add(line);
            }
        }
        if (buffer.Count > 0) items.Add(string.Join("\n", buffer).Trim());
        if (items.Count == expectedCount && items.All(t => t.Length > 0)) return items.ToArray();
        return null;
    }

    public static string StripCodeFences(string text)
    {
        var m = System.Text.RegularExpressions.Regex.Match(text, "```(?:json)?\\s*([\\s\\S]*?)```",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return (m.Success ? m.Groups[1].Value : text).Trim();
    }
}