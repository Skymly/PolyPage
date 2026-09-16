using PolyPage.Gateway;

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
}
