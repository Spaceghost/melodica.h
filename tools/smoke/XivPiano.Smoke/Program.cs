// The release smoke test for XivPiano's core, headless. The plugin itself runs inside Final Fantasy XIV
// (its windows are Dalamud ImGui windows, drawn by the game), so nothing of its UI can be rendered here;
// what can be proven is that the released XivPiano.Core.dll loads the native melodica bridge and, pointed
// at a Pandora-protocol server (melodica-tuner), logs in, lists stations and fetches a playlist.
//
// Environment:
//   XIVPIANO_SMOKE_ZIP        the released plugin zip (hashed and listed)
//   XIVPIANO_SMOKE_RELEASE    the folder it was extracted to (the XivPiano.Core.dll this program runs is its)
//   XIVPIANO_SMOKE_OUT        where smoke-core.json and smoke-core.txt go
//   XIVPIANO_SMOKE_PLATFORM   label for the report (default: core (headless))
//   XIVPIANO_MELODICA_LIBRARY the native bridge to load (read by XivPiano.Core; Windows: the zip's DLL by default)
//   XIVPIANO_API_HOST         host[:port] of the test server (read by XivPiano.Core); unset: no login is tried
//   XIVPIANO_CA_BUNDLE        PEM file of the test server's CA (read by XivPiano.Core's PandoraHttp)
//   XIVPIANO_TUNER_USER / XIVPIANO_TUNER_PASSWORD   the account the test server accepts
//   XIVPIANO_TUNER_URL        the server's URL, recorded in the report only
//   XIVPIANO_TUNER_VERSION    the server's version, recorded as "tuner" (the shape tuner/report.py writes)
//   XIVPIANO_SMOKE_EXPECT_TUNER=1  fail (exit 1) unless the full login/stations/playlist path passed
//
// Exit status: 0 when every step that was attempted passed, 1 otherwise. ok in the JSON is true only
// when all five steps passed.
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using XivPiano.Core.Pandora;

var outDir = Env("XIVPIANO_SMOKE_OUT") ?? Directory.GetCurrentDirectory();
Directory.CreateDirectory(outDir);
using var log = new StreamWriter(Path.Combine(outDir, "smoke-core.txt"), append: false) { AutoFlush = true };
var steps = new List<string>();
string? failure = null;
var report = new JsonObject
{
    ["ok"] = false,
    ["platform"] = Env("XIVPIANO_SMOKE_PLATFORM") ?? "core (headless)",
    ["summary"] = "core loads the released DLLs and the native bridge",
    ["when"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
    ["steps"] = new JsonArray(),
    ["tuner"] = "none",
};

Log($"xivpiano smoke harness, {RuntimeInformationLine()}");
try
{
    // 1. released zip loaded: the zip's entries and hashes, and the XivPiano.Core.dll this process runs
    //    is byte-for-byte the zip's.
    var zipPath = Env("XIVPIANO_SMOKE_ZIP") ?? throw new InvalidOperationException("XIVPIANO_SMOKE_ZIP is not set");
    var releaseDir = Env("XIVPIANO_SMOKE_RELEASE") ?? throw new InvalidOperationException("XIVPIANO_SMOKE_RELEASE is not set");
    Log($"zip: {zipPath}");
    Log($"release folder: {releaseDir}");
    var zipHashes = new Dictionary<string, string>();
    using (var zip = System.IO.Compression.ZipFile.OpenRead(zipPath))
    {
        foreach (var entry in zip.Entries.Where(e => !e.FullName.EndsWith('/')))
        {
            using var stream = entry.Open();
            zipHashes[entry.FullName] = Convert.ToHexStringLower(SHA256.HashData(stream));
        }
    }
    foreach (var required in new[] { "XivPiano.dll", "XivPiano.Core.dll", "XivPiano.json", "runtimes/win-x64/native/xivpiano_melodica.dll" })
    {
        if (!zipHashes.TryGetValue(required, out var hash))
            throw new InvalidOperationException($"{required} is not in the released zip");
        Log($"zip entry {required} sha256 {hash}");
    }
    var core = typeof(PandoraClient).Assembly;
    var coreLocation = core.Location;
    var coreHash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(coreLocation)));
    Log($"running {core.GetName().Name} {core.GetName().Version} from {coreLocation} sha256 {coreHash}");
    if (coreHash != zipHashes["XivPiano.Core.dll"])
        throw new InvalidOperationException("the XivPiano.Core.dll in this process is not the released one");
    var pluginName = AssemblyName.GetAssemblyName(Path.Combine(releaseDir, "XivPiano.dll"));
    Log($"released plugin assembly: {pluginName.Name} {pluginName.Version} (not loaded: it needs Dalamud and the game)");
    var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(releaseDir, "XivPiano.json")))!;
    Log($"released manifest: {manifest["InternalName"]} AssemblyVersion {manifest["AssemblyVersion"]} DalamudApiLevel {manifest["DalamudApiLevel"]}");
    report["release"] = new JsonObject
    {
        ["zip"] = Path.GetFileName(zipPath),
        ["zip_sha256"] = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(zipPath))),
        ["core_sha256"] = coreHash,
        ["plugin_sha256"] = zipHashes["XivPiano.dll"],
        ["bridge_win_x64_sha256"] = zipHashes["runtimes/win-x64/native/xivpiano_melodica.dll"],
        ["assembly_version"] = manifest["AssemblyVersion"]?.GetValue<string>(),
    };
    Step("released zip loaded");

    // 2. bridge loaded: a partner login through a handler that answers 503 proves the native bridge was
    //    loaded and built the request (the URL and body come out of it), without any network.
    var probe = new ProbeHandler();
    using (var offline = new PandoraClient(new HttpClient(probe)))
    {
        try
        {
            await offline.LoginAsync("smoke@example.test", "no", CancellationToken.None);
            throw new InvalidOperationException("the probe handler did not stop the login");
        }
        catch (HttpRequestException) { }
    }
    var request = probe.Seen ?? throw new InvalidOperationException("the bridge built no request");
    Log($"bridge built POST {request.Scheme}://{request.Host}{request.AbsolutePath}{request.Query} with a {probe.BodyLength}-byte body");
    if (request.Scheme != "https" || !request.Query.Contains("method=auth.partnerLogin"))
        throw new InvalidOperationException("the bridge's request is not the partner login");
    var loader = LoaderState(core);
    var bridgePath = loader?.LoadedPath ?? throw new InvalidOperationException("XivPiano.Core reports no loaded native module");
    var bridgeHash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(loader.Value.Source ?? bridgePath)));
    Log($"native bridge: {loader.Value.Source} (loaded as {bridgePath}) sha256 {bridgeHash}, loads {loader.Value.Loads}");
    var isReleasedDll = bridgeHash == zipHashes["runtimes/win-x64/native/xivpiano_melodica.dll"];
    Log(isReleasedDll
        ? "the bridge is the released win-x64 DLL"
        : "the bridge is a Linux build of the same bridge source, not the released win-x64 DLL");
    report["bridge"] = new JsonObject
    {
        ["path"] = loader.Value.Source,
        ["sha256"] = bridgeHash,
        ["released_win_x64_dll"] = isReleasedDll,
        ["os"] = Environment.OSVersion.Platform.ToString(),
    };
    Step("bridge loaded");

    // 3..5. against the test server, when one is named.
    var endpoint = ApiEndpoint.FromEnvironment();
    if (endpoint == null)
    {
        Log("XIVPIANO_API_HOST is not set: no server was contacted; login, stations and playlist were not tried");
    }
    else
    {
        var user = Env("XIVPIANO_TUNER_USER") ?? throw new InvalidOperationException("XIVPIANO_TUNER_USER is not set");
        var password = Env("XIVPIANO_TUNER_PASSWORD") ?? throw new InvalidOperationException("XIVPIANO_TUNER_PASSWORD is not set");
        var ca = Env("XIVPIANO_CA_BUNDLE");
        report["tuner"] = Env("XIVPIANO_TUNER_VERSION") ?? "unknown";
        report["server"] = new JsonObject
        {
            ["url"] = Env("XIVPIANO_TUNER_URL"),
            ["api_host"] = endpoint.ToString(),
            ["ca_bundle"] = ca == null ? "platform store" : Path.GetFileName(ca),
            ["user"] = user,
        };
        Log($"server: {endpoint} (XIVPIANO_API_HOST), trust: {(ca == null ? "platform store" : ca)}");
        using var http = new HttpClient(PandoraHttp.CreateHandler()) { Timeout = TimeSpan.FromSeconds(60) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"XivPiano/{core.GetName().Version?.ToString(3)} smoke/{(OperatingSystem.IsWindows() ? "win-x64" : "linux-x64")}");
        using var client = new PandoraClient(http);
        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var account = await client.LoginAsync(user, password, cts.Token);
        Log($"logged in as {user}: user id {account.UserId}, client {account.Client}, paid {account.IsPaid}, partner {client.Partner.DeviceModel} on {client.Partner.Host}");
        var tunerLog = new JsonArray();
        tunerLog.Add("auth.partnerLogin");
        tunerLog.Add("auth.userLogin");
        Step("logged in");

        var stations = await client.GetStationsAsync(cts.Token);
        if (stations.Count == 0)
            throw new InvalidOperationException("the server listed no stations");
        Log($"{stations.Count} stations: {string.Join(", ", stations.Select(s => s.Name + (s.IsQuickMix ? " (shuffle)" : "")))}");
        tunerLog.Add("user.getStationList");
        Step("stations listed");

        var station = stations.FirstOrDefault(s => !s.IsQuickMix) ?? stations[0];
        var tracks = await client.GetPlaylistAsync(station.Token, cts.Token);
        if (tracks.Count == 0)
            throw new InvalidOperationException($"the playlist for {station.Name} is empty");
        Log($"playlist for {station.Name}: {tracks.Count} songs, first \"{tracks[0].Title}\" by {tracks[0].Artist} ({tracks[0].AudioEncoding} {tracks[0].Bitrate} kbit/s, {tracks[0].Length:m\\:ss})");
        tunerLog.Add("station.getPlaylist");
        Step("playlist fetched");
        ((JsonObject)report["server"]!)["methods"] = tunerLog;
        ((JsonObject)report["server"]!)["stations"] = stations.Count;
        ((JsonObject)report["server"]!)["playlist"] = new JsonObject { ["station"] = station.Name, ["songs"] = tracks.Count, ["bitrate"] = tracks[0].Bitrate };
        report["ok"] = true;
        report["summary"] = "the released XivPiano.Core logged in, listed stations and fetched a playlist through the melodica native bridge against melodica-tuner";
    }
}
catch (Exception e)
{
    failure = e.GetType().Name + ": " + e.Message;
    Log("FAILED " + failure);
    if (e.InnerException != null) Log("  caused by " + e.InnerException.GetType().Name + ": " + e.InnerException.Message);
    report["error"] = failure;
}

report["ui"] = "not rendered: the plugin's windows are Dalamud ImGui windows drawn inside the game; there is no headless surface";
report["summary"] = report["summary"]!.GetValue<string>() + "; in-game UI not observed";
var json = report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n";
File.WriteAllText(Path.Combine(outDir, "smoke-core.json"), json);
Log("report: " + Path.Combine(outDir, "smoke-core.json"));
Console.Write(json);
var expectTuner = Env("XIVPIANO_SMOKE_EXPECT_TUNER") == "1";
if (failure != null)
    return 1;
if (expectTuner && !report["ok"]!.GetValue<bool>())
{
    Log("FAILED XIVPIANO_SMOKE_EXPECT_TUNER=1 but the server path was not completed");
    return 1;
}
return 0;

void Step(string name)
{
    steps.Add(name);
    ((JsonArray)report["steps"]!).Add(name);
    Log("step ok: " + name);
}

void Log(string line)
{
    var stamped = DateTimeOffset.UtcNow.ToString("HH:mm:ss.fff") + " " + line;
    Console.Error.WriteLine(stamped);
    log.WriteLine(stamped);
}

static string? Env(string name)
{
    var value = Environment.GetEnvironmentVariable(name);
    return string.IsNullOrWhiteSpace(value) ? null : value;
}

static string RuntimeInformationLine() =>
    $"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription} on {System.Runtime.InteropServices.RuntimeInformation.OSDescription} ({System.Runtime.InteropServices.RuntimeInformation.OSArchitecture})";

// XivPiano.Core keeps the loader's state internal; the harness reads it by reflection to record which
// module was loaded, and never calls into the native module itself.
static (int Loads, string? Source, string? LoadedPath)? LoaderState(Assembly core)
{
    var type = core.GetType("XivPiano.Core.Pandora.MelodicaProtocol");
    var property = type?.GetProperty("LoaderState", BindingFlags.NonPublic | BindingFlags.Static);
    if (property?.GetValue(null) is not ITuple state)
        return null;
    return ((int)state[0]!, state[4] as string, state[5] as string);
}

sealed class ProbeHandler : HttpMessageHandler
{
    public Uri? Seen { get; private set; }
    public long BodyLength { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Seen = request.RequestUri;
        BodyLength = (await request.Content!.ReadAsByteArrayAsync(ct)).LongLength;
        return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("smoke probe") };
    }
}
