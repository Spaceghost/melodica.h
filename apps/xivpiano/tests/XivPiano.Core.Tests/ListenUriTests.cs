using XivPiano.Core.Pandora;

namespace XivPiano.Core.Tests;

/// <summary>melodica-scrobble tests/listen-uri.test.mjs, ported case for case: the same links are accepted and rejected.</summary>
public class ListenUriTests
{
    private static string? Field(ListenUri p, string key) => key switch
    {
        "target" => p.Target,
        "name" => p.Name,
        "station" => p.Station,
        "track" => p.Track,
        "land" => p.Land,
        "province" => p.Province,
        "username" => p.User,
        "t" => p.T?.ToString(System.Globalization.CultureInfo.InvariantCulture),
        _ => throw new ArgumentException(key),
    };

    public static TheoryData<string, string[]> Good => new()
    {
        { "listen://artist/Modest%20Mouse", ["target", "artist", "name", "Modest Mouse"] },
        { "web+listen://genre/thrash%20metal", ["target", "genre", "name", "thrash metal"] },
        { "https://spacegho.st/listen/station/4123456789012345", ["target", "station", "station", "4123456789012345"] },
        { "listen://track/" + new string('a', 64) + "?t=95", ["target", "track", "track", new string('a', 64), "t", "95"] },
        { "listen://map/neon-plains/synthwave-reach", ["target", "map", "land", "neon-plains", "province", "synthwave-reach"] },
        { "listen://map/neon-plains", ["target", "map", "land", "neon-plains"] },
        { "listen://user/knewter", ["target", "user", "username", "knewter"] },
        { "listen://listens", ["target", "listens"] },
        { "LISTEN://Leaderboard/", ["target", "leaderboard"] },
        { "listen://artist/Sigur%20R%C3%B3s", ["target", "artist", "name", "Sigur Rós"] },
    };

    [Theory]
    [MemberData(nameof(Good))]
    public void ParsesEveryTargetInAllThreeForms(string u, string[] want)
    {
        var p = ListenUri.Parse(u);
        Assert.NotNull(p);
        for (int i = 0; i < want.Length; i += 2)
            Assert.Equal(want[i + 1], Field(p, want[i]));
        Assert.Equal(p.Uri, ListenUri.Parse(p.Https)!.Uri); // https round trip
        Assert.Equal(p.Uri, ListenUri.Parse(p.Web)!.Uri);   // web+ round trip
    }

    [Fact]
    public void NamesAndBuilding()
    {
        Assert.Null(ListenUri.Parse("listen://artist/AC%2FDC")); // no slash inside a name
        Assert.Equal("https://spacegho.st/listen/artist/Guns%20N'%20Roses", ListenUri.Build("artist", name: "Guns N' Roses")!.Https);
        Assert.Equal("Guns N' Roses", ListenUri.Parse(ListenUri.Build("artist", name: "Guns N' Roses")!.Uri)!.Name);
    }

    public static TheoryData<string?> Bad => new()
    {
        "listen://http://evil.example", "listen://url/https%3A%2F%2Fevil.example", "listen://artist", "listen://artist/a/b",
        "listen://artist/%00x", "listen://artist/%2e%2e", "listen://artist/" + new string('x', 201), "listen://artist/%E0%A4%A",
        "listen://artist/ x", "listen://artist/x?autoplay=1", "listen://track/zzz!?t=1", "listen://track/abc?t=999999",
        "listen://track/abc?t=1&t=2", "listen://map/Neon_Plains", "listen://map/a/b/c", "listen://user/A", "listen://station/12-34",
        "listen://artist/x#frag", "javascript:alert(1)", "https://evil.example/listen/artist/x", "https://spacegho.st/listen/../oauth/admin",
        "listen://listens/extra", "listen://artist/<script>", null, // 42 and null in the reference: C# only has strings, so null stands for both
    };

    [Theory]
    [MemberData(nameof(Bad))]
    public void RejectsAnythingNotAllowListed(string? u) => Assert.Null(ListenUri.Parse(u!));

    [Fact]
    public void BuildRejectsWhatWouldNotParse()
    {
        Assert.Null(ListenUri.Build("url", name: "x"));
        Assert.Null(ListenUri.Build("artist", name: ".."));
        Assert.NotNull(ListenUri.Build("artist", name: "...")); // three dots is a name
        Assert.Null(ListenUri.Build("user", user: "NO"));
    }

    [Fact]
    public void RoutesStayOnSpaceghostMelodicaPages()
    {
        Assert.Equal("/melodica/app/?seed=artist:Modest%20Mouse", ListenUri.Parse("listen://artist/Modest%20Mouse")!.Route);
        Assert.Equal("/melodica/map/?land=neon-plains&province=synthwave-reach", ListenUri.Parse("listen://map/neon-plains/synthwave-reach")!.Route);
        Assert.Equal("/melodica/listens/?track=abc&t=5", ListenUri.Parse("listen://track/abc?t=5")!.Route);
        foreach (var u in new[] { "listen://listens", "listen://leaderboard", "listen://user/knewter", "listen://station/123", "listen://genre/dance" })
            Assert.StartsWith("/melodica/", ListenUri.Parse(u)!.Route);
    }
}

/// <summary>What a link does in XivPiano: never plays by itself.</summary>
public class ListenLinkTests
{
    private static readonly Station[] Mine =
    [
        new("tok1", "111", "Modest Mouse Radio", false, false),
        new("tok2", "222", "Chill", false, false),
        new("tok3", "333", "Shuffle", true, false),
    ];

    [Fact]
    public void ArtistAndGenreAskBeforeTheirStation()
    {
        var p = ListenLinks.Plan("listen://artist/Modest%20Mouse", Mine);
        Assert.Equal(ListenLinkAction.SeedStation, p.Action);
        Assert.Equal("111", p.Station!.Id);
        Assert.Equal("Start the Modest Mouse station?", p.Message);
        var g = ListenLinks.Plan("https://spacegho.st/listen/genre/thrash%20metal", Mine);
        Assert.Equal(ListenLinkAction.SeedStation, g.Action);
        Assert.Null(g.Station); // made from a search after the listener says yes
        Assert.Equal(ListenLinkAction.Unsupported, ListenLinks.Plan("listen://artist/x", null).Action); // signed out
    }

    [Fact]
    public void StationsMustBeInTheList()
    {
        var p = ListenLinks.Plan("listen://station/222", Mine);
        Assert.Equal((ListenLinkAction.Station, "Start Chill?"), (p.Action, p.Message));
        Assert.Equal(ListenLinkAction.StationMissing, ListenLinks.Plan("listen://station/999", Mine).Action);
    }

    [Theory]
    [InlineData("listen://track/abc?t=5", "https://spacegho.st/melodica/listens/?track=abc&t=5")]
    [InlineData("listen://map/neon-plains", "https://spacegho.st/melodica/map/?land=neon-plains")]
    [InlineData("web+listen://user/knewter", "https://spacegho.st/melodica/leaderboard/?user=knewter")]
    [InlineData("listen://listens", "https://spacegho.st/melodica/listens/")]
    [InlineData("listen://leaderboard", "https://spacegho.st/melodica/leaderboard/")]
    public void EverythingElseOpensSpaceghost(string link, string url)
    {
        var p = ListenLinks.Plan(link, null);
        Assert.Equal((ListenLinkAction.Browser, url), (p.Action, p.BrowserUrl));
    }

    [Theory]
    [InlineData("listen://artist/x?autoplay=1")]
    [InlineData("https://evil.example/listen/artist/x")]
    [InlineData("")]
    [InlineData(null)]
    public void InvalidLinksDoNothing(string? link) =>
        Assert.Equal((ListenLinkAction.Unsupported, "That link isn't supported."), (ListenLinks.Plan(link, Mine).Action, ListenLinks.Plan(link, Mine).Message));

    [Fact]
    public void SeedSearchPrefersTheSameName()
    {
        var link = ListenUri.Parse("listen://artist/Modest%20Mouse")!;
        var results = new[]
        {
            new SearchResult(SearchKind.Song, "S1", "Float On", "Modest Mouse", 100),
            new SearchResult(SearchKind.Artist, "R2", "Modest Mouse Tribute", null, 99),
            new SearchResult(SearchKind.Artist, "R1", "Modest Mouse", null, 90),
        };
        Assert.Equal("R1", ListenLinks.PickSeed(link, results)!.MusicToken);
        Assert.Equal("G1", ListenLinks.PickSeed(ListenUri.Parse("listen://genre/Jazz")!, [new SearchResult(SearchKind.Genre, "G1", "Jazz Radio", null, 1)])!.MusicToken);
        Assert.Null(ListenLinks.PickSeed(link, [results[0]]));
    }
}
