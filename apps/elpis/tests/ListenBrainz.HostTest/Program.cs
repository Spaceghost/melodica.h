using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using Elpis.Links;
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

        ListenUriCases();
        ListenLinkCases();
        if (OperatingSystem.IsWindows()) SchemeRegistration();

        var server = Environment.GetEnvironmentVariable("LB_SERVER");
        if (!string.IsNullOrEmpty(server))
            EndToEnd(server, File.ReadAllText(Environment.GetEnvironmentVariable("LB_TOKEN_FILE")).Trim());

        Console.WriteLine(failures == 0 ? "all checks passed" : failures + " check(s) failed");
        return failures == 0 ? 0 : 1;
    }

    static string Field(ListenUri p, string key)
    {
        switch (key)
        {
            case "target": return p.Target;
            case "name": return p.Name;
            case "station": return p.Station;
            case "track": return p.Track;
            case "land": return p.Land;
            case "province": return p.Province;
            case "username": return p.User;
            case "t": return p.T.HasValue ? p.T.Value.ToString() : null;
            default: throw new ArgumentException(key);
        }
    }

    // melodica-scrobble tests/listen-uri.test.mjs, ported case for case.
    static void ListenUriCases()
    {
        var cases = new (string, string[])[]
        {
            ("listen://artist/Modest%20Mouse", new[] { "target", "artist", "name", "Modest Mouse" }),
            ("web+listen://genre/thrash%20metal", new[] { "target", "genre", "name", "thrash metal" }),
            ("https://spacegho.st/listen/station/4123456789012345", new[] { "target", "station", "station", "4123456789012345" }),
            ("listen://track/" + new string('a', 64) + "?t=95", new[] { "target", "track", "track", new string('a', 64), "t", "95" }),
            ("listen://map/neon-plains/synthwave-reach", new[] { "target", "map", "land", "neon-plains", "province", "synthwave-reach" }),
            ("listen://map/neon-plains", new[] { "target", "map", "land", "neon-plains" }),
            ("listen://user/knewter", new[] { "target", "user", "username", "knewter" }),
            ("listen://listens", new[] { "target", "listens" }),
            ("LISTEN://Leaderboard/", new[] { "target", "leaderboard" }),
            ("listen://artist/Sigur%20R%C3%B3s", new[] { "target", "artist", "name", "Sigur R\u00f3s" }),
        };
        foreach (var (u, want) in cases)
        {
            var p = ListenUri.Parse(u);
            var ok = p != null;
            for (int i = 0; ok && i < want.Length; i += 2) ok = Field(p, want[i]) == want[i + 1];
            ok = ok && ListenUri.Parse(p.Https).Uri == p.Uri && ListenUri.Parse(p.Web).Uri == p.Uri;
            Check(ok, "listen: parses " + u + " (and its https and web+ forms)");
        }
        Check(ListenUri.Parse("listen://artist/AC%2FDC") == null, "listen: no slash inside a name");
        Check(ListenUri.Build("artist", name: "Guns N' Roses").Https == "https://spacegho.st/listen/artist/Guns%20N'%20Roses", "listen: builds the https form");
        Check(ListenUri.Parse(ListenUri.Build("artist", name: "Guns N' Roses").Uri).Name == "Guns N' Roses", "listen: build round trip");

        var bad = new[]
        {
            "listen://http://evil.example", "listen://url/https%3A%2F%2Fevil.example", "listen://artist", "listen://artist/a/b",
            "listen://artist/%00x", "listen://artist/%2e%2e", "listen://artist/" + new string('x', 201), "listen://artist/%E0%A4%A",
            "listen://artist/ x", "listen://artist/x?autoplay=1", "listen://track/zzz!?t=1", "listen://track/abc?t=999999",
            "listen://track/abc?t=1&t=2", "listen://map/Neon_Plains", "listen://map/a/b/c", "listen://user/A", "listen://station/12-34",
            "listen://artist/x#frag", "javascript:alert(1)", "https://evil.example/listen/artist/x", "https://spacegho.st/listen/../oauth/admin",
            "listen://listens/extra", "listen://artist/<script>", null, // 42 and null in the reference: null stands for both
        };
        foreach (var u in bad) Check(ListenUri.Parse(u) == null, "listen: rejects " + (u ?? "null"));
        Check(ListenUri.Build("url", name: "x") == null, "listen: no url target");
        Check(ListenUri.Build("artist", name: "..") == null, "listen: .. is not a name");
        Check(ListenUri.Build("artist", name: "...") != null, "listen: three dots is a name");
        Check(ListenUri.Build("user", user: "NO") == null, "listen: user names are lower case");

        Check(ListenUri.Parse("listen://artist/Modest%20Mouse").Route == "/melodica/app/?seed=artist:Modest%20Mouse", "listen: artist route");
        Check(ListenUri.Parse("listen://map/neon-plains/synthwave-reach").Route == "/melodica/map/?land=neon-plains&province=synthwave-reach", "listen: map route");
        Check(ListenUri.Parse("listen://track/abc?t=5").Route == "/melodica/listens/?track=abc&t=5", "listen: track route");
        foreach (var u in new[] { "listen://listens", "listen://leaderboard", "listen://user/knewter", "listen://station/123", "listen://genre/dance" })
            Check(ListenUri.Parse(u).Route.StartsWith("/melodica/"), "listen: " + u + " routes under /melodica/");
    }

    // What a link does in Elpis: it asks first, and never plays by itself.
    static void ListenLinkCases()
    {
        var mine = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("111", "Modest Mouse Radio"), new KeyValuePair<string, string>("222", "Chill"), new KeyValuePair<string, string>("333", "Jazz Radio") };
        var a = ListenLinks.Plan("listen://artist/Modest%20Mouse", mine);
        Check(a.Action == ListenLinkAction.SeedStation && a.StationId == "111" && a.Message == "Start the Modest Mouse station?", "link: artist offers your station");
        var n = ListenLinks.Plan("listen://artist/Radiohead", mine);
        Check(n.Action == ListenLinkAction.SeedStation && n.StationId == null, "link: unknown artist offers to make one");
        Check(ListenLinks.Plan("listen://genre/jazz", mine).StationId == "333", "link: genre offers your station");
        var g = ListenLinks.Plan("listen://genre/thrash%20metal", mine);
        Check(g.Action == ListenLinkAction.Browser && g.BrowserUrl == "https://spacegho.st/melodica/app/?seed=genre:thrash%20metal", "link: a new genre station opens on spacegho.st");
        var s = ListenLinks.Plan("listen://station/222", mine);
        Check(s.Action == ListenLinkAction.Station && s.Message == "Start Chill?", "link: station in the list");
        Check(ListenLinks.Plan("listen://station/999", mine).Action == ListenLinkAction.StationMissing, "link: station not in the list");
        Check(ListenLinks.Plan("listen://station/222", null).Action == ListenLinkAction.Unsupported, "link: stations wait for sign-in");
        var t = ListenLinks.Plan("https://spacegho.st/listen/track/abc?t=5", null);
        Check(t.Action == ListenLinkAction.Browser && t.BrowserUrl == "https://spacegho.st/melodica/listens/?track=abc&t=5", "link: track opens its page");
        Check(ListenLinks.Plan("listen://leaderboard", null).BrowserUrl == "https://spacegho.st/melodica/leaderboard/", "link: leaderboard opens its page");
        var bad = ListenLinks.Plan("listen://artist/x?autoplay=1", mine);
        Check(bad.Action == ListenLinkAction.Unsupported && bad.Message == "That link isn't supported.", "link: invalid links do nothing");
        Check(ListenLinks.FindLink(new[] { "C:\\Elpis.exe", "listen://artist/x" }) == "listen://artist/x", "link: found among the arguments");
        Check(ListenLinks.FindLink(new[] { "-playpause" }) == null, "link: none among plain options");
        Check(ListenScheme.ExeOf(ListenScheme.CommandFor("C:\\Program Files\\Elpis\\Elpis.exe")) == "C:\\Program Files\\Elpis\\Elpis.exe", "scheme: the command names Elpis");
    }

    // Windows only: write a throwaway scheme under HKCU, read it back, and remove it.
    static void SchemeRegistration()
    {
        const string scheme = "listen-elpis-ci-check";
        var exe = Environment.ProcessPath;
        try
        {
            Check(ListenScheme.Register(exe, false, scheme), "scheme: registers when nothing handles it");
            Check(ListenScheme.RegisteredCommand(scheme) == "\"" + exe + "\" \"%1\"" && ListenScheme.IsRegisteredTo(exe, scheme), "scheme: opens this program with the link");
            Check(!ListenScheme.Register("C:\\other.exe", false, scheme), "scheme: does not take over a working handler");
            ListenScheme.Register("C:\\missing\\other.exe", true, scheme);
            Check(ListenScheme.Register(exe, false, scheme) && ListenScheme.IsRegisteredTo(exe, scheme), "scheme: replaces a handler that no longer exists");
        }
        finally
        {
            Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree("Software\\Classes\\" + scheme, false);
        }
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
