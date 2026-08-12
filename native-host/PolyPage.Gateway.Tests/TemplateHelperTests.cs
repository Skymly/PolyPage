using PolyPage.Gateway.Backends;
using Xunit;

namespace PolyPage.Gateway.Tests;

public class TemplateHelperTests
{
    [Fact]
    public void ParseBatch_AcceptsJsonArray()
    {
        var parsed = TemplateHelper.ParseBatchTranslation("[\"一\", \"二\"]", 2);
        Assert.Equal(new[] { "一", "二" }, parsed);
    }

    [Fact]
    public void ParseBatch_AcceptsNumberedList()
    {
        var parsed = TemplateHelper.ParseBatchTranslation("1) first\n2) second", 2);
        Assert.Equal(new[] { "first", "second" }, parsed);
    }

    [Fact]
    public void ParseBatch_SingleReturnsWholeReply()
    {
        var parsed = TemplateHelper.ParseBatchTranslation("  whole reply  ", 1);
        Assert.Equal(new[] { "whole reply" }, parsed);
    }

    [Fact]
    public void ParseBatch_StripsCodeFences()
    {
        var fence = new string((char)96, 3);
        var reply = fence + "json\n[\"a\", \"b\"]\n" + fence;
        var parsed = TemplateHelper.ParseBatchTranslation(reply, 2);
        Assert.Equal(new[] { "a", "b" }, parsed);
    }

    [Fact]
    public void ParseBatch_RejectsCountMismatch()
    {
        Assert.Null(TemplateHelper.ParseBatchTranslation("[\"only one\"]", 2));
    }

    [Fact]
    public void GetByPath_WalksObjectsAndArrays()
    {
        using var doc = System.Text.Json.JsonDocument.Parse(
            "{\"data\":{\"translations\":[{\"text\":\"hi\"}]}}");
        var value = TemplateHelper.GetByPath(doc.RootElement, "data.translations.0.text");
        Assert.Equal("hi", value?.GetString());
        Assert.Null(TemplateHelper.GetByPath(doc.RootElement, "data.missing"));
    }

    [Fact]
    public void Render_ReplacesKnownVarsAndKeepsUnknown()
    {
        var rendered = TemplateHelper.Render("{{a}} and {{b}}", new Dictionary<string, string> { ["a"] = "X" });
        Assert.Equal("X and {{b}}", rendered);
    }

    [Fact]
    public void ExtractStrings_AcceptsObjectsWithTextKeys()
    {
        using var doc = System.Text.Json.JsonDocument.Parse(
            "[{\"translatedText\":\"一\"},{\"translation\":\"二\"}]");
        var texts = TemplateHelper.ExtractStrings(doc.RootElement);
        Assert.Equal(new[] { "一", "二" }, texts);
    }
}