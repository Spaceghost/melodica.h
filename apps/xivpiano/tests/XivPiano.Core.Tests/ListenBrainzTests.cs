using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using XivPiano.Core.Pandora;

namespace XivPiano.Core.Tests;

/// <summary>ListenBrainz-compatible scrobbling: spacegho.st by default, the listen's metadata, and the offline queue.</summary>
public sealed class ListenBrainzTests : IDisposable
{
    private const string Secret = "sgs_secret_token_never_logged";
    private readonly string dir = Path.Combine(Path.GetTempPath(), "xivpiano-lb-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(dir))
            Directory.Delete(dir, true);
    }

    private static Track Song(string token = "PANDORA_TRACK_TOKEN", string? art = "http://mediaserver-cont.pandora.com/images/a.jpg") =>
        new(token, "station42", "Answers", "Susan Calloway", "FFXIV", art, "https://audio/x.mp3", "mp3", 128, TimeSpan.FromSeconds(200), false, 0, null, DateTimeOffset.UnixEpoch);

    private sealed class Server : HttpMessageHandler
    {
        public readonly List<(string Url, string Auth, JsonObject Body)> Requests = [];
        public Func<JsonObject, HttpStatusCode> Answer = _ => HttpStatusCode.OK;
        public bool Offline;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            if (Offline)
                throw new HttpRequestException("No connection could be made.");
            var text = r.Content == null ? "{}" : await r.Content.ReadAsStringAsync(ct);
            var body = (JsonObject)JsonNode.Parse(text)!;
            Requests.Add((r.RequestUri!.ToString(), string.Join(",", r.Headers.GetValues("Authorization")), body));
            var status = r.Method == HttpMethod.Get ? HttpStatusCode.OK : Answer(body);
            var answer = r.Method == HttpMethod.Get ? """{"code":200,"valid":true,"user_name":"tester"}""" : """{"status":"ok"}""";
            return new(status) { Content = new StringContent(answer, Encoding.UTF8, "application/json") };
        }
    }

    [Fact]
    public void SpaceGhostIsTheDefault()
    {
        var lb = new ListenBrainz(new HttpClient(), Secret);
        Assert.Equal("https://spacegho.st/scrobble", lb.Server);
        Assert.Equal("https://spacegho.st/scrobble", ListenBrainzServers.Normalize(""));
        Assert.Equal("https://api.listenbrainz.org", ListenBrainzServers.Normalize(" https://api.listenbrainz.org/ "));
        Assert.Null(ListenBrainzServers.Normalize("ftp://x"));
        Assert.Null(ListenBrainzServers.Normalize("https://user:pw@x"));
        Assert.Null(ListenBrainzServers.Normalize("not a url"));
    }

    [Fact]
    public void MetadataCarriesArtStationAndDuration()
    {
        var b = ListenBrainz.Body("single", Song(), DateTimeOffset.FromUnixTimeSeconds(1_790_000_000), "Chill Radio", "0.1.2.1");
        var info = b["payload"]![0]!["track_metadata"]!["additional_info"]!;
        Assert.Equal("http://mediaserver-cont.pandora.com/images/a.jpg", info["art_url"]!.GetValue<string>()); // http, as Pandora gives it
        Assert.Equal("Chill Radio", info["station_name"]!.GetValue<string>());
        Assert.Equal(200_000, info["duration_ms"]!.GetValue<long>());
        Assert.Equal("pandora.com", info["music_service"]!.GetValue<string>());
        Assert.Equal("Pandora", info["music_service_name"]!.GetValue<string>());
        Assert.Equal("XivPiano", info["submission_client"]!.GetValue<string>());
        Assert.Equal("0.1.2.1", info["submission_client_version"]!.GetValue<string>());
        // No Pandora identifiers: the service does not store them.
        var json = b.ToJsonString();
        Assert.DoesNotContain("PANDORA_TRACK_TOKEN", json);
        Assert.DoesNotContain("station42", json);
        Assert.DoesNotContain("audio/x.mp3", json);
        Assert.Null(ListenBrainz.Body("playing_now", Song(art: null), null)["payload"]![0]!["track_metadata"]!["additional_info"]!["art_url"]);
    }

    [Fact]
    public async Task NowPlayingAndListenGoToTheServerWithTheToken()
    {
        var server = new Server();
        var lb = new ListenBrainz(new HttpClient(server), Secret, stationName: _ => "Chill Radio");
        await lb.NowPlayingAsync(Song(), CancellationToken.None);
        await lb.ScrobbleAsync(Song(), DateTimeOffset.FromUnixTimeSeconds(1_790_000_000), CancellationToken.None);
        Assert.Equal(["playing_now", "single"], server.Requests.Select(r => r.Body["listen_type"]!.GetValue<string>()));
        Assert.All(server.Requests, r => Assert.Equal("https://spacegho.st/scrobble/1/submit-listens", r.Url));
        Assert.All(server.Requests, r => Assert.Equal("Token " + Secret, r.Auth));
        Assert.Equal("Chill Radio", server.Requests[1].Body["payload"]![0]!["track_metadata"]!["additional_info"]!["station_name"]!.GetValue<string>());
        var (valid, user) = await lb.ValidateAsync(CancellationToken.None);
        Assert.True(valid);
        Assert.Equal("tester", user);
    }

    [Theory]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.Unauthorized)]
    public async Task FailedListensAreQueuedAndSentLater(HttpStatusCode failure)
    {
        var server = new Server { Answer = _ => failure };
        var path = Path.Combine(dir, "queue.json");
        var lb = new ListenBrainz(new HttpClient(server), Secret, queue: new ListenQueue(path));
        var e = await Assert.ThrowsAsync<HttpRequestException>(() => lb.ScrobbleAsync(Song(), DateTimeOffset.FromUnixTimeSeconds(1_790_000_000), CancellationToken.None));
        Assert.Contains("queued", e.Message);
        Assert.DoesNotContain(Secret, e.Message);
        Assert.True(File.Exists(path));
        Assert.DoesNotContain(Secret, File.ReadAllText(path));

        // A new process: the queue comes back from its file and goes out as an import before the next listen.
        server.Answer = _ => HttpStatusCode.OK;
        var again = new ListenBrainz(new HttpClient(server), Secret, queue: new ListenQueue(path));
        await again.ScrobbleAsync(Song("t2"), DateTimeOffset.FromUnixTimeSeconds(1_790_000_300), CancellationToken.None);
        var import = server.Requests[^2].Body;
        Assert.Equal("import", import["listen_type"]!.GetValue<string>());
        Assert.Equal(1_790_000_000, import["payload"]![0]!["listened_at"]!.GetValue<long>());
        Assert.Equal("single", server.Requests[^1].Body["listen_type"]!.GetValue<string>());
        Assert.Equal(0, new ListenQueue(path).Count);
    }

    [Fact]
    public async Task OfflineListensAreQueuedAndBadOnesDropped()
    {
        var server = new Server { Offline = true };
        var queue = new ListenQueue(Path.Combine(dir, "q.json"));
        var lb = new ListenBrainz(new HttpClient(server), Secret, queue: queue);
        for (int i = 0; i < 3; i++)
            await Assert.ThrowsAsync<HttpRequestException>(() => lb.ScrobbleAsync(Song("t" + i), DateTimeOffset.FromUnixTimeSeconds(1_790_000_000 + i * 300), CancellationToken.None));
        Assert.Equal(3, queue.Count);

        // Back online; the server refuses the middle listen as invalid: it is dropped, the others are kept.
        server.Offline = false;
        server.Answer = b => b["payload"]!.AsArray().Any(l => l!["listened_at"]!.GetValue<long>() == 1_790_000_300) ? HttpStatusCode.BadRequest : HttpStatusCode.OK;
        Assert.True(await lb.TryFlushAsync(CancellationToken.None));
        Assert.Equal(0, queue.Count);
        var accepted = server.Requests.Where(r => r.Body["listen_type"]!.GetValue<string>() == "import" && r.Body["payload"]!.AsArray().Count == 1)
            .Select(r => r.Body["payload"]![0]!["listened_at"]!.GetValue<long>()).ToList();
        Assert.Contains(1_790_000_000, accepted);
        Assert.Contains(1_790_000_600, accepted);
    }

    [Fact]
    public async Task QueueIsPerServerAndCapped()
    {
        var queue = new ListenQueue(Path.Combine(dir, "cap.json"), capacity: 2);
        for (int i = 0; i < 3; i++)
            queue.Add("https://a", new JsonObject { ["listened_at"] = i });
        queue.Add("https://b", new JsonObject { ["listened_at"] = 9 });
        Assert.Equal(2, queue.Count); // the oldest went first
        Assert.Equal(1, queue.CountFor("https://a"));
        var sent = new List<JsonArray>();
        Assert.Equal(1, await queue.FlushAsync((l, _) => { sent.Add(l); return Task.FromResult(200); }, "https://b", CancellationToken.None));
        Assert.Equal(9, sent.Single()[0]!["listened_at"]!.GetValue<int>());
        Assert.Equal(1, queue.CountFor("https://a"));
    }

    [Fact]
    public async Task PlayingNowIsNeverQueued()
    {
        var server = new Server { Answer = _ => HttpStatusCode.ServiceUnavailable };
        var queue = new ListenQueue(Path.Combine(dir, "np.json"));
        var lb = new ListenBrainz(new HttpClient(server), Secret, queue: queue);
        var e = await Assert.ThrowsAsync<HttpRequestException>(() => lb.NowPlayingAsync(Song(), CancellationToken.None));
        Assert.DoesNotContain(Secret, e.Message);
        Assert.Equal(0, queue.Count);
    }
}

/// <summary>
/// Against a real server, skipped unless XIVPIANO_LB_SERVER is set: playing now, then one listen. The token is read
/// from the file XIVPIANO_LB_TOKEN_FILE and never printed. When the server refuses the first listen for now (a fake
/// started with --fail), the listen is queued and goes out as an import ahead of a second one.
/// </summary>
public sealed class ListenBrainzEndToEnd
{
    [Fact]
    public async Task SubmitsToTheServer()
    {
        var server = Environment.GetEnvironmentVariable("XIVPIANO_LB_SERVER");
        Assert.SkipUnless(!string.IsNullOrEmpty(server), "set XIVPIANO_LB_SERVER and XIVPIANO_LB_TOKEN_FILE to submit listens");
        var token = File.ReadAllText(Environment.GetEnvironmentVariable("XIVPIANO_LB_TOKEN_FILE")!).Trim();
        var title = Environment.GetEnvironmentVariable("XIVPIANO_LB_TITLE") ?? "melodica-client-test xivpiano";
        var queuePath = Path.Combine(Path.GetTempPath(), "xivpiano-lb-e2e-" + Guid.NewGuid().ToString("N") + ".json");
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var lb = new ListenBrainz(http, token, server!, new ListenQueue(queuePath), _ => "melodica client test", "e2e");
        var (valid, _) = await lb.ValidateAsync(CancellationToken.None);
        Assert.True(valid, "validate-token");
        var song = new Track("e2e", "s", title, "Test Artist", "Test Album", "http://mediaserver-cont-dc6-1-v4v6.pandora.com/images/public/test.jpg",
            "", "mp3", 128, TimeSpan.FromSeconds(200), false, 0, null, DateTimeOffset.UtcNow);
        try
        {
            await lb.NowPlayingAsync(song, CancellationToken.None);
            Console.WriteLine("e2e: playing_now ok");
        }
        catch (HttpRequestException e)
        {
            // Playing now is never queued: a fake started with --fail refuses it first.
            Assert.DoesNotContain(token, e.Message);
            Assert.Equal(0, new ListenQueue(queuePath).Count);
            Console.WriteLine("e2e: playing_now refused, not queued: " + e.Message);
        }

        var started = DateTimeOffset.UtcNow.AddSeconds(-120);
        try
        {
            await lb.ScrobbleAsync(song, started, CancellationToken.None);
            Console.WriteLine("e2e: single ok");
        }
        catch (HttpRequestException e) when (e.Message.Contains("queued", StringComparison.Ordinal))
        {
            Assert.DoesNotContain(token, e.Message);
            Console.WriteLine("e2e: single queued: " + e.Message);
            await lb.ScrobbleAsync(song with { Token = "e2e-2", Title = title + " 2" }, started.AddSeconds(60), CancellationToken.None);
            Assert.Equal(0, new ListenQueue(queuePath).Count);
            Console.WriteLine("e2e: queue flushed as import, second single ok");
        }
        finally
        {
            File.Delete(queuePath);
        }
    }
}
