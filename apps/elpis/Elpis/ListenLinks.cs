/*
 * What a listen:// link does in Elpis (melodica-scrobble docs/LISTEN-URI.md). Plain C# 7.3 with
 * no WPF, so the host checks build it too. Links never play by themselves: Elpis asks first.
 */
using System;
using System.Collections.Generic;
using System.Linq;

namespace Elpis.Links
{
    public enum ListenLinkAction
    {
        /// <summary>Not a valid link: "That link isn't supported".</summary>
        Unsupported,
        /// <summary>artist (or a genre you already have a station for): ask, then play or make the station.</summary>
        SeedStation,
        /// <summary>station/&lt;id&gt; in your list: ask, then play it.</summary>
        Station,
        /// <summary>station/&lt;id&gt; that is not in your list.</summary>
        StationMissing,
        /// <summary>Everything else: ask, then open the spacegho.st page.</summary>
        Browser,
    }

    public class ListenLinkPlan
    {
        public ListenLinkAction Action;
        public ListenUri Link;
        /// <summary>Your station to play, when you have one; null means make one (artist links).</summary>
        public string StationId;
        public string BrowserUrl;
        /// <summary>The question to confirm, or the answer when there is nothing to confirm.</summary>
        public string Message;
    }

    public static class ListenLinks
    {
        public const string Unsupported = "That link isn't supported.";

        /// <summary>The first argument that looks like a link (even an invalid one, so it can be refused), or null.</summary>
        public static string FindLink(IEnumerable<string> args)
        {
            foreach (var a in args ?? new string[0])
            {
                var s = (a ?? "").Trim();
                var l = s.ToLowerInvariant();
                if (l.StartsWith("listen:", StringComparison.Ordinal) || l.StartsWith("web+listen:", StringComparison.Ordinal)
                    || l.StartsWith("https://spacegho.st/listen/", StringComparison.Ordinal))
                    return s;
            }
            return null;
        }

        /// <summary>Pandora names artist stations "&lt;name&gt; Radio"; a renamed one may be just the name.</summary>
        public static string FindStation(string name, IEnumerable<KeyValuePair<string, string>> stations)
        {
            foreach (var s in stations)
                if (string.Equals(s.Value, name + " Radio", StringComparison.OrdinalIgnoreCase) || string.Equals(s.Value, name, StringComparison.OrdinalIgnoreCase))
                    return s.Key;
            return null;
        }

        /// <summary>stations: (id, name) of the signed-in listener's stations, or null when signed out.</summary>
        public static ListenLinkPlan Plan(string input, IList<KeyValuePair<string, string>> stations)
        {
            var link = input == null ? null : ListenUri.Parse(input.Trim());
            if (link == null) return new ListenLinkPlan { Action = ListenLinkAction.Unsupported, Message = Unsupported };
            var page = ListenUri.Site + link.Route;
            switch (link.Target)
            {
                case "artist":
                case "genre":
                    if (stations == null) return new ListenLinkPlan { Action = ListenLinkAction.Unsupported, Link = link, Message = "Sign in to Pandora first." };
                    var have = FindStation(link.Name, stations);
                    if (have != null || link.Target == "artist")
                        return new ListenLinkPlan { Action = ListenLinkAction.SeedStation, Link = link, StationId = have, Message = "Start the " + link.Name + " station?" };
                    // Elpis cannot make genre stations (Pandora's search here has no genres): melodica on spacegho.st can.
                    return new ListenLinkPlan { Action = ListenLinkAction.Browser, Link = link, BrowserUrl = page,
                        Message = "Elpis can't make genre stations. Open the " + link.Name + " station on spacegho.st?" };
                case "station":
                    if (stations == null) return new ListenLinkPlan { Action = ListenLinkAction.Unsupported, Link = link, Message = "Sign in to Pandora first." };
                    var s = stations.FirstOrDefault(x => x.Key == link.Station);
                    if (s.Key == null) return new ListenLinkPlan { Action = ListenLinkAction.StationMissing, Link = link, Message = "That station isn't in your station list." };
                    return new ListenLinkPlan { Action = ListenLinkAction.Station, Link = link, StationId = s.Key, Message = "Start " + s.Value + "?" };
                default:
                    return new ListenLinkPlan { Action = ListenLinkAction.Browser, Link = link, BrowserUrl = page, Message = "Open " + page + " in your browser?" };
            }
        }
    }
}
