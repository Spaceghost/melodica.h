using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using XivPiano.Core.Pandora;

namespace XivPiano.Core;

/// <summary>Somewhere listens are reported: Last.fm (as Elpis and Pithos do) or ListenBrainz.</summary>
public interface IScrobbler
{
    string Name { get; }

    Task NowPlayingAsync(Track track, CancellationToken ct);

    Task ScrobbleAsync(Track track, DateTimeOffset startedAt, CancellationToken ct);
}

/// <summary>
/// When a listen counts, by the rule Last.fm sets and ListenBrainz follows: the song is longer than 30 seconds and
/// has played for half its length or four minutes, whichever comes first. Reported once per play.
/// </summary>
public sealed class ScrobbleRule
{
    private string? playing;
    private bool reported;

    public static bool Counts(TimeSpan length, TimeSpan played) =>
        length > TimeSpan.FromSeconds(30) && played >= TimeSpan.FromTicks(Math.Min(length.Ticks / 2, TimeSpan.FromMinutes(4).Ticks));

    /// <summary>True exactly once per play of a track, when it has played enough.</summary>
    public bool Due(Track track, TimeSpan played)
    {
        if (track.Token != playing)
        {
            playing = track.Token;
            reported = false;
        }

        if (reported || !Counts(track.Length, played))
            return false;
        reported = true;
        return true;
    }
}

/// <summary>
/// Last.fm's scrobbling API 2.0 with desktop authorization: <see cref="BeginAuthAsync"/> gets a token and the page
/// where the listener approves it, <see cref="FinishAuthAsync"/> turns the approved token into a session key that
/// lasts until revoked. Calls are signed with the API secret (md5 over the sorted parameters).
/// </summary>
public sealed class LastFm(HttpClient http, string apiKey, string apiSecret, string? sessionKey = null) : IScrobbler
{
    public const string Endpoint = "https://ws.audioscrobbler.com/2.0/";

    public string Name => "Last.fm";

    public string? SessionKey { get; private set; } = sessionKey;

    public async Task<(string Token, string ApproveUrl)> BeginAuthAsync(CancellationToken ct)
    {
        var r = await CallAsync(new SortedDictionary<string, string>(StringComparer.Ordinal) { ["method"] = "auth.getToken" }, get: true, ct).ConfigureAwait(false);
        var token = r["token"]?.GetValue<string>() ?? throw new FormatException("Last.fm gave no token.");
        return (token, $"https://www.last.fm/api/auth/?api_key={Uri.EscapeDataString(apiKey)}&token={Uri.EscapeDataString(token)}");
    }

    public async Task<string> FinishAuthAsync(string token, CancellationToken ct)
    {
        var r = await CallAsync(new SortedDictionary<string, string>(StringComparer.Ordinal) { ["method"] = "auth.getSession", ["token"] = token }, get: true, ct).ConfigureAwait(false);
        SessionKey = r["session"]?["key"]?.GetValue<string>() ?? throw new FormatException("Last.fm gave no session; approve XivPiano on the page first.");
        return SessionKey;
    }

    public Task NowPlayingAsync(Track track, CancellationToken ct) =>
        CallAsync(TrackParams("track.updateNowPlaying", track), get: false, ct);

    public Task ScrobbleAsync(Track track, DateTimeOffset startedAt, CancellationToken ct)
    {
        var p = TrackParams("track.scrobble", track);
        p["timestamp"] = startedAt.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return CallAsync(p, get: false, ct);
    }

    private SortedDictionary<string, string> TrackParams(string method, Track t)
    {
        var p = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["method"] = method,
            ["artist"] = t.Artist,
            ["track"] = t.Title,
            ["sk"] = SessionKey ?? throw new InvalidOperationException("Connect Last.fm first."),
        };
        if (t.Album.Length > 0)
            p["album"] = t.Album;
        if (t.Length > TimeSpan.Zero)
            p["duration"] = ((int)t.Length.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return p;
    }

    /// <summary>api_sig: md5 of every parameter (but format) as name+value, sorted by name, then the secret.</summary>
    internal static string Sign(IEnumerable<KeyValuePair<string, string>> parameters, string secret)
    {
        var text = new StringBuilder();
        foreach (var (k, v) in parameters.Where(p => p.Key != "format").OrderBy(p => p.Key, StringComparer.Ordinal))
            text.Append(k).Append(v);
        text.Append(secret);
#pragma warning disable CA5351 // Last.fm's protocol defines the signature as md5
        return Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes(text.ToString())));
#pragma warning restore CA5351
    }

    private async Task<JsonObject> CallAsync(SortedDictionary<string, string> p, bool get, CancellationToken ct)
    {
        p["api_key"] = apiKey;
        p["api_sig"] = Sign(p, apiSecret);
        p["format"] = "json";
        HttpResponseMessage response;
        if (get)
        {
            var query = string.Join("&", p.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));
            response = await http.GetAsync(Endpoint + "?" + query, ct).ConfigureAwait(false);
        }
        else
        {
            using var body = new FormUrlEncodedContent(p);
            response = await http.PostAsync(Endpoint, body, ct).ConfigureAwait(false);
        }

        using (response)
        {
            var node = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false)) as JsonObject ?? [];
            if (node["error"] != null)
                throw new HttpRequestException($"Last.fm: {node["message"]?.GetValue<string>() ?? "error " + node["error"]}");
            return node;
        }
    }
}

/// <summary>Where ListenBrainz-compatible listens can go: spacegho.st's scrobble service (the default) or listenbrainz.org.</summary>
public static class ListenBrainzServers
{
    public const string SpaceGhost = "https://spacegho.st/scrobble";
    public const string ListenBrainzOrg = "https://api.listenbrainz.org";

    /// <summary>Where spacegho.st tokens are made.</summary>
    public const string SpaceGhostTokens = "https://spacegho.st/melodica/account/";

    /// <summary>The base URL with no trailing slash (the API lives under <c>{base}/1/</c>), or null when it is not an http(s) URL.</summary>
    public static string? Normalize(string? url)
    {
        var u = (url ?? "").Trim().TrimEnd('/');
        if (u.Length == 0)
            return SpaceGhost;
        if (!Uri.TryCreate(u, UriKind.Absolute, out var parsed) || (parsed.Scheme != "https" && parsed.Scheme != "http")
            || parsed.UserInfo.Length > 0 || parsed.Query.Length > 0 || parsed.Fragment.Length > 0)
            return null;
        return u;
    }
}

/// <summary>
/// Listens that could not be sent (offline, a timeout, 429, 5xx or a rejected token), kept in a JSON file and sent
/// again oldest first, up to 100 at a time as a ListenBrainz import. A 400 drops the listen it was about. Each
/// entry remembers its server, so changing servers never sends old listens to the new one. Never holds a token.
/// </summary>
public sealed class ListenQueue(string path, int capacity = 1000)
{
    private readonly object gate = new();
    private readonly SemaphoreSlim flushing = new(1, 1);
    private List<JsonObject>? items;

    public int Count
    {
        get { lock (gate) return Load().Count; }
    }

    public int CountFor(string server)
    {
        lock (gate) return Load().Count(i => i["server"]?.GetValue<string>() == server);
    }

    public void Add(string server, JsonNode listen)
    {
        lock (gate)
        {
            var list = Load();
            list.Add(new JsonObject { ["server"] = server, ["listen"] = listen.DeepClone() });
            if (list.Count > capacity)
                list.RemoveRange(0, list.Count - capacity); // the oldest go first
            Save(list);
        }
    }

    /// <summary>Sends what is queued for <paramref name="server"/>. Returns how many were accepted; throws on the first failure that keeps them.</summary>
    public async Task<int> FlushAsync(Func<JsonArray, CancellationToken, Task<int>> submitImport, string server, CancellationToken ct)
    {
        if (!await flushing.WaitAsync(0, ct).ConfigureAwait(false))
            return 0;
        try
        {
            int sent = 0;
            while (true)
            {
                List<JsonObject> batch;
                lock (gate)
                    batch = Load().Where(i => i["server"]?.GetValue<string>() == server).Take(100).ToList();
                if (batch.Count == 0)
                    return sent;
                var status = await submitImport(new JsonArray(batch.Select(b => b["listen"]!.DeepClone()).ToArray()), ct).ConfigureAwait(false);
                if (status == 400 && batch.Count > 1)
                {
                    // One bad listen must not hold back the rest: send them one by one, dropping only the bad ones.
                    foreach (var one in batch)
                    {
                        var s1 = await submitImport(new JsonArray(one["listen"]!.DeepClone()), ct).ConfigureAwait(false);
                        if (ListenBrainz.Keeps(s1))
                            throw new HttpRequestException(ListenBrainz.Describe(s1));
                        Remove([one]);
                        if (s1 is >= 200 and < 300)
                            sent++;
                    }

                    continue;
                }

                if (ListenBrainz.Keeps(status))
                    throw new HttpRequestException(ListenBrainz.Describe(status));
                Remove(batch);
                if (status is >= 200 and < 300)
                    sent += batch.Count;
            }
        }
        finally
        {
            flushing.Release();
        }
    }

    private void Remove(List<JsonObject> done)
    {
        lock (gate)
        {
            var list = Load();
            list.RemoveAll(i => done.Any(d => ReferenceEquals(d, i)));
            Save(list);
        }
    }

    private List<JsonObject> Load()
    {
        if (items != null)
            return items;
        items = [];
        try
        {
            if (File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonArray a)
                items.AddRange(a.OfType<JsonObject>().Where(o => o["server"] is JsonValue && o["listen"] is JsonObject).Select(o => (JsonObject)o.DeepClone()));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            // A damaged queue file is started over; it holds only listens, never credentials.
        }

        return items;
    }

    private void Save(List<JsonObject> list)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path));
        if (dir != null)
            Directory.CreateDirectory(dir);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, new JsonArray(list.Select(i => i.DeepClone()).ToArray()).ToJsonString());
        File.Move(tmp, path, overwrite: true);
    }
}

/// <summary>
/// A ListenBrainz-compatible server (spacegho.st's scrobble service by default, or listenbrainz.org): a user token,
/// no app key. Listens that fail for a reason that may pass (offline, 429, 5xx, a rejected token) wait in the
/// <see cref="ListenQueue"/> and go out with the next successful contact. The token is sent only in the
/// Authorization header and never appears in an error message.
/// </summary>
public sealed class ListenBrainz(HttpClient http, string userToken, string endpoint = ListenBrainzServers.SpaceGhost,
    ListenQueue? queue = null, Func<Track, string?>? stationName = null, string clientVersion = "") : IScrobbler
{
    private readonly string server = ListenBrainzServers.Normalize(endpoint) ?? throw new ArgumentException("The ListenBrainz server must be an http(s) URL.", nameof(endpoint));

    public string Name => server == ListenBrainzServers.SpaceGhost ? "spacegho.st scrobbles" : server == ListenBrainzServers.ListenBrainzOrg ? "ListenBrainz" : "ListenBrainz (" + server + ")";

    public string Server => server;

    public async Task NowPlayingAsync(Track track, CancellationToken ct)
    {
        await TryFlushAsync(ct).ConfigureAwait(false);
        var status = await PostAsync(Body("playing_now", track, null, stationName?.Invoke(track), clientVersion), ct).ConfigureAwait(false);
        if (status is < 200 or >= 300)
            throw new HttpRequestException(Describe(status));
    }

    public async Task ScrobbleAsync(Track track, DateTimeOffset startedAt, CancellationToken ct)
    {
        await TryFlushAsync(ct).ConfigureAwait(false);
        var body = Body("single", track, startedAt, stationName?.Invoke(track), clientVersion);
        int status;
        try
        {
            status = await PostAsync(body, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            status = 0;
        }

        if (status is >= 200 and < 300)
            return;
        if (queue != null && Keeps(status))
        {
            queue.Add(server, body["payload"]![0]!);
            throw new HttpRequestException(Describe(status) + " The listen is queued and will be sent again.");
        }

        throw new HttpRequestException(Describe(status));
    }

    /// <summary>Sends the queued listens for this server now; false when they stay queued.</summary>
    public async Task<bool> TryFlushAsync(CancellationToken ct)
    {
        if (queue == null || queue.CountFor(server) == 0)
            return true;
        try
        {
            await queue.FlushAsync((listens, c) => PostAsync(new JsonObject { ["listen_type"] = "import", ["payload"] = listens }, c), server, ct).ConfigureAwait(false);
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return false;
        }
    }

    /// <summary>The server's answer to the token: valid, and the user name it belongs to.</summary>
    public async Task<(bool Valid, string? User)> ValidateAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, server + "/1/validate-token");
        request.Headers.TryAddWithoutValidation("Authorization", "Token " + userToken);
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException(Describe((int)response.StatusCode));
        var node = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false)) as JsonObject ?? [];
        return (node["valid"]?.GetValue<bool>() == true, node["user_name"]?.GetValue<string>());
    }

    /// <summary>Statuses whose listen is kept for later: no answer (0), a rejected token (401), 429 and 5xx.</summary>
    internal static bool Keeps(int status) => status is 0 or 401 or 408 or 429 or >= 500;

    internal static string Describe(int status) => status switch
    {
        0 => "The ListenBrainz server could not be reached.",
        401 => "The ListenBrainz server rejected the token; set a new one in Settings.",
        _ => $"The ListenBrainz server answered {status}.",
    };

    internal static JsonObject Body(string type, Track t, DateTimeOffset? at, string? station = null, string clientVersion = "")
    {
        var info = new JsonObject
        {
            ["media_player"] = "XivPiano",
            ["submission_client"] = "XivPiano",
            ["music_service"] = "pandora.com",
            ["music_service_name"] = "Pandora",
        };
        if (clientVersion.Length > 0)
        {
            info["submission_client_version"] = clientVersion;
            info["media_player_version"] = clientVersion;
        }

        if (t.Length > TimeSpan.Zero)
            info["duration_ms"] = (long)t.Length.TotalMilliseconds;
        // Exactly as Pandora gives it, http or https: the scrobble service caches a copy.
        if (t.ArtUrl is { Length: > 0 } art && (art.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || art.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
            info["art_url"] = art;
        if (station is { Length: > 0 })
            info["station_name"] = station;
        var meta = new JsonObject
        {
            ["artist_name"] = t.Artist,
            ["track_name"] = t.Title,
            ["additional_info"] = info,
        };
        if (t.Album.Length > 0)
            meta["release_name"] = t.Album;
        var listen = new JsonObject { ["track_metadata"] = meta };
        if (at is { } a)
            listen["listened_at"] = a.ToUnixTimeSeconds();
        return new JsonObject { ["listen_type"] = type, ["payload"] = new JsonArray(listen) };
    }

    private async Task<int> PostAsync(JsonObject body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, server + "/1/submit-listens")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("Authorization", "Token " + userToken);
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        return (int)response.StatusCode;
    }
}
