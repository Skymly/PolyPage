using System.Text.Json;
using PolyPage.Gateway;
using Xunit;

namespace PolyPage.Gateway.Tests;

public sealed class InstallerTests
{
    [Fact]
    public void DefaultHostKeepsHistoricalExeName()
    {
        Assert.Equal("PolyPage.Gateway.exe", Installer.InstalledExecutableFileName(Installer.DefaultHostName));
    }

    [Fact]
    public void AlternateHostUsesOwnExeFile()
    {
        Assert.Equal(
            "com.skymly.polypage.gateway.smoke.exe",
            Installer.InstalledExecutableFileName("com.skymly.polypage.gateway.smoke"));
    }

    [Fact]
    public void ChromeOriginMustBeExtensionUrlWithTrailingSlash()
    {
        Assert.True(Installer.IsChromeExtensionOrigin("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/"));
        Assert.True(Installer.IsChromeExtensionOrigin("chrome-extension://placeholder/"));
        Assert.False(Installer.IsChromeExtensionOrigin("https://evil.example/"));
        Assert.False(Installer.IsChromeExtensionOrigin("chrome-extension://placeholder"));
        Assert.False(Installer.IsChromeExtensionOrigin(""));
    }

    [Fact]
    public void AllowOriginsReplaceTheStoredList()
    {
        var stored = new[] { "chrome-extension://oldidoldidoldidoldidoldidoldido/" };
        var next = Installer.ResolveOrigins(stored, ["chrome-extension://placeholder/"]);
        Assert.Equal(["chrome-extension://placeholder/"], next);
    }

    [Fact]
    public void EmptyAllowKeepsStoredOrigins()
    {
        var stored = new[] { "chrome-extension://placeholder/" };
        Assert.Equal(stored, Installer.ResolveOrigins(stored, []));
    }

    [Fact]
    public void ChromiumManifestOmitsFirefoxAllowedExtensions()
    {
        var json = JsonSerializer.Serialize(
            Installer.ChromiumManifest("com.skymly.polypage.gateway", @"C:\gw.exe", ["chrome-extension://placeholder/"]));
        Assert.Contains("allowed_origins", json);
        Assert.DoesNotContain("allowed_extensions", json);
        var fx = JsonSerializer.Serialize(
            Installer.FirefoxManifest("com.skymly.polypage.gateway", @"C:\gw.exe", [Installer.DefaultGeckoId]));
        Assert.Contains("allowed_extensions", fx);
        Assert.DoesNotContain("allowed_origins", fx);
    }

    [Fact]
    public void UninstallRemovesGatewayJsonOnlyForDefaultHost()
    {
        Assert.True(Installer.RemovesGatewayConfig(Installer.DefaultHostName));
        Assert.False(Installer.RemovesGatewayConfig("com.skymly.polypage.gateway.smoke"));
    }
}

