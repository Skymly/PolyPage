using PolyPage.Gateway;
using PolyPage.Gateway.Backends;

// ---------------------------------------------------------------------------
// PolyPage Gateway — Native Messaging host (spec 2.0 pillar A).
//
// Subcommands:
//   (none)                 run as Native Messaging host on stdio
//   --install [--allow O]  install registry keys + manifest (Windows, HKCU)
//   --uninstall            remove them
//   --status               show installation status
//   --host-name NAME       override the default host name for the above
// ---------------------------------------------------------------------------

var argsList = new List<string>(args);
string hostName = Installer.DefaultHostName;
var hostNameIndex = argsList.IndexOf("--host-name");
if (hostNameIndex >= 0 && hostNameIndex + 1 < argsList.Count)
{
    hostName = argsList[hostNameIndex + 1];
    argsList.RemoveRange(hostNameIndex, 2);
}
Installer.HostName = hostName;

if (argsList.Contains("--install"))
{
    var origins = new List<string>();
    for (var i = 0; i < argsList.Count; i++)
    {
        if (argsList[i] == "--allow" && i + 1 < argsList.Count)
        {
            origins.Add(argsList[i + 1]);
            i++;
        }
    }
    return Installer.Install(origins.ToArray());
}
if (argsList.Contains("--uninstall")) return Installer.Uninstall();
if (argsList.Contains("--status")) return Installer.Status();

using var log = new GatewayLog();
try
{
    var config = await GatewayConfig.LoadAsync();
    var backends = new List<IGatewayBackend>();
    foreach (var ollama in config.Ollama) backends.Add(new OllamaBackend(ollama));
    foreach (var http in config.Http) backends.Add(new HttpBackend(http));
    if (backends.Count == 0)
    {
        log.Error("no backends configured in gateway.json");
        return 1;
    }
    var defaultBackend = !string.IsNullOrWhiteSpace(config.DefaultBackend) &&
                         backends.Any(b => b.Id == config.DefaultBackend)
        ? config.DefaultBackend
        : backends[0].Id;

    var server = new GatewayServer(backends, defaultBackend, log);
    using var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;
        cts.Cancel();
    };

    var stdin = Console.OpenStandardInput();
    var stdout = Console.OpenStandardOutput();
    await server.RunAsync(stdin, stdout, cts.Token);
    return 0;
}
catch (Exception e)
{
    log.Error($"fatal: {e}");
    return 1;
}