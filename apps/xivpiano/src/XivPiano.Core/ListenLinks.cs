using XivPiano.Core.Pandora;

namespace XivPiano.Core;

/// <summary>What a listen:// link asks XivPiano to do. Nothing here plays: playing is the listener's own confirmation.</summary>
public enum ListenLinkAction
{
    /// <summary>Not a link (or not one we accept): "That link isn't supported".</summary>
    Unsupported,

    /// <summary>artist/genre: after the listener confirms, tune in their station for it, or make one.</summary>
    SeedStation,

    /// <summary>station/&lt;id&gt; in the listener's list: after they confirm, tune in.</summary>
    Station,

    /// <summary>station/&lt;id&gt; that is not in the listener's list.</summary>
    StationMissing,

    /// <summary>Everything else (track, map, user, listens, leaderboard): open the spacegho.st page.</summary>
    Browser,
}

public sealed record ListenLinkPlan(ListenLinkAction Action, ListenUri? Link, Station? Station, string? BrowserUrl, string Message);

public static class ListenLinks
{
    public const string Unsupported = "That link isn't supported.";

    /// <summary>
    /// Decides what a link does. <paramref name="stations"/> is the signed-in listener's list, or null when nobody is
    /// signed in. The plan's message is the question to confirm (or the answer, when there is nothing to confirm).
    /// </summary>
    public static ListenLinkPlan Plan(string? input, IReadOnlyList<Station>? stations)
    {
        var link = input == null ? null : ListenUri.Parse(input.Trim());
        if (link == null)
            return new(ListenLinkAction.Unsupported, null, null, null, Unsupported);
        switch (link.Target)
        {
            case "artist":
            case "genre":
                if (stations == null)
                    return new(ListenLinkAction.Unsupported, link, null, null, "Sign in to Pandora first.");
                var have = FindSeedStation(link, stations);
                return new(ListenLinkAction.SeedStation, link, have, null, $"Start the {link.Name} station?");
            case "station":
                if (stations == null)
                    return new(ListenLinkAction.Unsupported, link, null, null, "Sign in to Pandora first.");
                var s = stations.FirstOrDefault(x => x.Id == link.Station);
                return s == null
                    ? new(ListenLinkAction.StationMissing, link, null, null, "That station isn't in your station list.")
                    : new(ListenLinkAction.Station, link, s, null, $"Start {s.Name}?");
            default:
                var url = ListenUri.Site + link.Route;
                return new(ListenLinkAction.Browser, link, null, url, $"Open {url} in your browser?");
        }
    }

    /// <summary>A station of yours for the artist or genre: Pandora names them "&lt;name&gt; Radio" (or just the name).</summary>
    public static Station? FindSeedStation(ListenUri link, IReadOnlyList<Station> stations) =>
        stations.FirstOrDefault(s => !s.IsQuickMix && (s.Name.Equals(link.Name + " Radio", StringComparison.OrdinalIgnoreCase)
            || s.Name.Equals(link.Name, StringComparison.OrdinalIgnoreCase)));

    /// <summary>The Pandora search result to seed a new station from: the same name if Pandora has it, else its best match of that kind.</summary>
    public static SearchResult? PickSeed(ListenUri link, IReadOnlyList<SearchResult> results)
    {
        var kind = link.Target == "genre" ? SearchKind.Genre : SearchKind.Artist;
        var ofKind = results.Where(r => r.Kind == kind && r.MusicToken.Length > 0).ToList();
        return ofKind.FirstOrDefault(r => r.Name.Equals(link.Name, StringComparison.OrdinalIgnoreCase)
                || (kind == SearchKind.Genre && r.Name.Equals(link.Name + " Radio", StringComparison.OrdinalIgnoreCase)))
            ?? ofKind.OrderByDescending(r => r.Score).FirstOrDefault();
    }
}
