using System;
using System.IO;
using System.Linq;
using Elpis.Scrobbling;

static class Program
{
    static int failures;

    static void Check(bool ok, string what)
    {
        Console.WriteLine((ok ? "ok   " : "FAIL ") + what);
        if (!ok) failures++;
    }

    static int Main()
    {
        // The rule: longer than 30 s, half the length or 4 minutes, once per play.
        Check(!ListenRule.Counts(TimeSpan.FromSeconds(200), TimeSpan.FromSeconds(99)), "rule: 99 of 200 s does not count");
        Check(ListenRule.Counts(TimeSpan.FromSeconds(200), TimeSpan.FromSeconds(100)), "rule: half counts");
        Check(ListenRule.Counts(TimeSpan.FromSeconds(600), TimeSpan.FromSeconds(240)), "rule: 4 minutes count");
        Check(!ListenRule.Counts(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30)), "rule: 30 s songs never count");
        var rule = new ListenRule();
        object a = new object(), b = new object();
        Check(rule.Started(a) && !rule.Started(a), "rule: a new play starts once");
        Check(!rule.Due(a, TimeSpan.FromSeconds(200), TimeSpan.FromSeconds(50)) && rule.Due(a, TimeSpan.FromSeconds(200), TimeSpan.FromSeconds(120))
              && !rule.Due(a, TimeSpan.FromSeconds(200), TimeSpan.FromSeconds(150)) && rule.Due(b, TimeSpan.FromSeconds(200), TimeSpan.FromSeconds(120)),
              "rule: once per play");

        Check(ListenBrainzServers.Normalize("") == ListenBrainzServers.SpaceGhost, "server: spacegho.st is the default");
        Check(ListenBrainzServers.Normalize("https://api.listenbrainz.org/ ") == ListenBrainzServers.ListenBrainzOrg, "server: trailing slash trimmed");
        Check(ListenBrainzServers.Normalize("ftp://x") == null && ListenBrainzServers.Normalize("https://u:p@x") == null, "server: only plain http(s)");

        var t = new ListenTrack { Artist = "A \"quoted\"\n", Title = "T\\", Album = "LP", ArtUrl = "http://mediaserver-cont.pandora.com/a.jpg", StationName = "Chill", Length = TimeSpan.FromSeconds(200) };
        var json = ListenJson.Listen(t, 1790000000, "1.2.3");
        Check(json.Contains("\"artist_name\":\"A \\\"quoted\\\"\\n\""), "json: strings escaped");
        Check(json.Contains("\"art_url\":\"http://mediaserver-cont.pandora.com/a.jpg\""), "json: http art as Pandora gives it");
        Check(json.Contains("\"station_name\":\"Chill\"") && json.Contains("\"duration_ms\":200000") && json.Contains("\"music_service\":\"pandora.com\"")
              && json.Contains("\"submission_client_version\":\"1.2.3\"") && json.StartsWith("{\"listened_at\":1790000000,"), "json: station, duration, service, version, time");
        Check(!ListenJson.Listen(new ListenTrack { Artist = "a", Title = "b" }, null, "").Contains("listened_at"), "json: playing now has no listened_at");

        var dir = Path.Combine(Path.GetTempPath(), "elpis-lb-" + Guid.NewGuid().ToString("N"));
        var q = new ListenQueue(Path.Combine(dir, "q.txt"), 2);
        q.Add("https://a", "{\"n\":1}"); q.Add("https://a", "{\"n\":2}"); q.Add("https://a", "{\"n\":3}"); q.Add("https://b", "{\"n\":9}");
        var q2 = new ListenQueue(Path.Combine(dir, "q.txt"), 2);
        Check(q2.Count == 2 && q2.CountFor("https://a") == 1 && q2.Peek("https://a", 10).Single() == "{\"n\":3}", "queue: persisted, capped oldest first, per server");
        q2.Remove("https://b", new[] { "{\"n\":9}" });
        Check(q2.CountFor("https://b") == 0 && q2.Count == 1, "queue: remove");
        Directory.Delete(dir, true);

        var server = Environment.GetEnvironmentVariable("LB_SERVER");
        if (!string.IsNullOrEmpty(server))
            EndToEnd(server, File.ReadAllText(Environment.GetEnvironmentVariable("LB_TOKEN_FILE")).Trim());

        Console.WriteLine(failures == 0 ? "all checks passed" : failures + " check(s) failed");
        return failures == 0 ? 0 : 1;
    }

    // Playing now, then a listen. When the server refuses (a fake started with --fail 2), playing now is
    // not queued, the listen is, and the next listen sends the queue first as an import.
    static void EndToEnd(string server, string token)
    {
        var title = Environment.GetEnvironmentVariable("LB_TITLE") ?? "melodica-client-test elpis";
        var qpath = Path.Combine(Path.GetTempPath(), "elpis-lb-e2e-" + Guid.NewGuid().ToString("N") + ".txt");
        var queue = new ListenQueue(qpath);
        var c = new ListenBrainzClient(server, token, queue) { ClientVersion = "e2e" };
        string user;
        Check(c.Validate(out user), "e2e: validate-token valid");
        var t = new ListenTrack { Artist = "Test Artist", Title = title, Album = "Test Album", StationName = "melodica client test",
            ArtUrl = "http://mediaserver-cont-dc6-1-v4v6.pandora.com/images/public/test.jpg", Length = TimeSpan.FromSeconds(200) };
        try { c.NowPlaying(t); Check(true, "e2e: playing_now accepted"); }
        catch (ListenBrainzException e) { Check(!e.Message.Contains(token) && queue.Count == 0, "e2e: playing_now refused (" + e.Status + "), not queued"); }
        var started = DateTime.UtcNow.AddSeconds(-120);
        try
        {
            c.Listen(t, started);
            Check(true, "e2e: single accepted");
        }
        catch (ListenBrainzException e)
        {
            Check(e.Message.Contains("queued") && !e.Message.Contains(token) && queue.Count == 1, "e2e: single refused (" + e.Status + "), queued");
            Check(!File.ReadAllText(qpath).Contains(token), "e2e: the queue file holds no token");
            c.Listen(new ListenTrack { Artist = t.Artist, Title = title + " 2", Album = t.Album, StationName = t.StationName, ArtUrl = t.ArtUrl, Length = t.Length }, started.AddSeconds(60));
            Check(queue.Count == 0, "e2e: queue sent as import, second single accepted");
        }
        File.Delete(qpath);
    }
}
