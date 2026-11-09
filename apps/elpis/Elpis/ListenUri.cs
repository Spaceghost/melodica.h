/*
 * listen:// links (melodica-scrobble docs/LISTEN-URI.md): parse and build.
 *
 * A port of melodica-scrobble src/listen-uri.js (the reference), written in plain C# 7.3 so
 * the same file builds into every C# client. It accepts and rejects exactly what the
 * reference does; the ported tests/listen-uri.test.mjs cases pin it, including the JavaScript
 * details that matter here: decodeURIComponent's strict UTF-8, String.prototype.trim's
 * whitespace set, encodeURIComponent's unreserved set, ASCII-only case folding of the scheme
 * and prefix, and toLowerCase of the target name.
 *
 *   listen://artist/<name>            listen://genre/<name>
 *   listen://station/<id>             listen://track/<id>?t=<seconds>
 *   listen://map/<land>[/<province>]  listen://user/<username>
 *   listen://listens                  listen://leaderboard
 *
 * Also accepted with the same paths: web+listen://... and https://spacegho.st/listen/...
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Elpis.Links
{
    public sealed class ListenUri
    {
        public const string HttpsBase = "https://spacegho.st/listen/";
        public const string Site = "https://spacegho.st";
        private const int MaxText = 200;

        private static readonly Regex Slug = new Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Username = new Regex("^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]\\z", RegexOptions.CultureInvariant);
        private static readonly Regex StationId = new Regex("^[A-Za-z0-9]{1,64}\\z", RegexOptions.CultureInvariant);
        private static readonly Regex TrackId = new Regex("^(?:[0-9a-f]{64}|[A-Za-z0-9]{1,64})\\z", RegexOptions.CultureInvariant);
        private static readonly Regex SegChars = new Regex("^[A-Za-z0-9\\-._~%!$&'()*+,;=:@]*\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Seconds = new Regex("^[0-9]{1,5}\\z", RegexOptions.CultureInvariant);

        // target -> segment rules ("?" = optional), allowed query keys, field names
        private static readonly Dictionary<string, string[]> Segs = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            { "artist", new[] { "text" } }, { "genre", new[] { "text" } }, { "station", new[] { "station" } },
            { "track", new[] { "track" } }, { "map", new[] { "slug", "slug?" } }, { "user", new[] { "username" } },
            { "listens", new string[0] }, { "leaderboard", new string[0] },
        };
        private static readonly Dictionary<string, string[]> Fields = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            { "artist", new[] { "name" } }, { "genre", new[] { "name" } }, { "station", new[] { "station" } },
            { "track", new[] { "track" } }, { "map", new[] { "land", "province" } }, { "user", new[] { "username" } },
            { "listens", new string[0] }, { "leaderboard", new string[0] },
        };

        public string Target { get; private set; }
        public string Name { get; private set; }
        public string Station { get; private set; }
        public string Track { get; private set; }
        public string Land { get; private set; }
        public string Province { get; private set; }
        public string User { get; private set; }
        /// <summary>track only: seconds into the track, or null.</summary>
        public int? T { get; private set; }

        /// <summary>The listen:// form.</summary>
        public string Uri { get; private set; }
        /// <summary>The web+listen:// form.</summary>
        public string Web { get; private set; }
        /// <summary>The https://spacegho.st/listen/ form: the one share buttons copy.</summary>
        public string Https { get; private set; }

        private ListenUri() { }

        private string Field(string f)
        {
            switch (f)
            {
                case "name": return Name;
                case "station": return Station;
                case "track": return Track;
                case "land": return Land;
                case "province": return Province;
                case "username": return User;
                default: return null;
            }
        }

        private void SetField(string f, string v)
        {
            switch (f)
            {
                case "name": Name = v; break;
                case "station": Station = v; break;
                case "track": Track = v; break;
                case "land": Land = v; break;
                case "province": Province = v; break;
                case "username": User = v; break;
            }
        }

        // ---- the JavaScript built-ins the reference relies on ---------------------------------

        private static char AsciiLower(char c) { return c >= 'A' && c <= 'Z' ? (char)(c + 32) : c; }

        /// <summary>a.toLowerCase().startsWith(prefix) for an ASCII lower-case prefix.</summary>
        private static bool StartsWithFolded(string s, string prefix)
        {
            if (s.Length < prefix.Length) return false;
            for (int i = 0; i < prefix.Length; i++)
                if (AsciiLower(s[i]) != prefix[i]) return false; // no other character lower-cases to one ASCII letter here
            return true;
        }

        /// <summary>String.prototype.toLowerCase, for comparing against the ASCII target names.</summary>
        private static string TargetLower(string s)
        {
            var b = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                if (c < 0x80) b.Append(AsciiLower(c));
                else if (c == '\u212a') b.Append('k'); // KELVIN SIGN lower-cases to "k" in JavaScript
                else return null; // anything else stays non-ASCII, so it can never name a target
            }
            return b.ToString();
        }

        /// <summary>The characters String.prototype.trim removes (WhiteSpace and LineTerminator).</summary>
        private static bool JsSpace(char c)
        {
            switch (c)
            {
                case '\t': case '\n': case '\v': case '\f': case '\r': case ' ':
                case '\u00a0': case '\u1680': case '\u2028': case '\u2029': case '\u202f': case '\u205f': case '\u3000': case '\ufeff':
                    return true;
                default:
                    return c >= '\u2000' && c <= '\u200a';
            }
        }

        /// <summary>decodeURIComponent; null where it throws (a bad %XX or invalid UTF-8).</summary>
        private static string DecodeUriComponent(string s)
        {
            if (s.IndexOf('%') < 0) return s;
            var bytes = new List<byte>(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if (c == '%')
                {
                    int hi, lo;
                    if (i + 2 >= s.Length || (hi = Hex(s[i + 1])) < 0 || (lo = Hex(s[i + 2])) < 0) return null;
                    bytes.Add((byte)(hi * 16 + lo));
                    i += 2;
                }
                else if (c < 0x80) bytes.Add((byte)c);
                else return null; // not reached: segments are ASCII by then
            }
            try { return new UTF8Encoding(false, true).GetString(bytes.ToArray()); }
            catch (ArgumentException) { return null; }
        }

        private static int Hex(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        /// <summary>encodeURIComponent; null where it throws (a lone surrogate).</summary>
        public static string EncodeUriComponent(string s)
        {
            var b = new StringBuilder(s.Length * 3);
            for (int i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || "-_.!~*'()".IndexOf(c) >= 0)
                {
                    b.Append(c);
                    continue;
                }
                string unit;
                if (char.IsHighSurrogate(c))
                {
                    if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return null;
                    unit = s.Substring(i, 2);
                    i++;
                }
                else if (char.IsLowSurrogate(c)) return null;
                else unit = c.ToString();
                foreach (var by in Encoding.UTF8.GetBytes(unit)) b.Append('%').Append(by.ToString("X2", CultureInfo.InvariantCulture));
            }
            return b.ToString();
        }

        // ---- the reference ------------------------------------------------------------------

        private static string DecodeSeg(string raw)
        {
            if (!SegChars.IsMatch(raw)) return null;
            var s = DecodeUriComponent(raw);
            if (string.IsNullOrEmpty(s) || s.Length > MaxText) return null;
            foreach (var c in s)
                if (c <= '\u001f' || c == '\u007f' || c == '/' || c == '\\') return null;
            if (JsSpace(s[0]) || JsSpace(s[s.Length - 1])) return null;
            if (s == "." || s == "..") return null; // never a path step in the https form
            return s.Normalize(NormalizationForm.FormC);
        }

        private static string CheckSeg(string rule, string v)
        {
            switch (rule.Replace("?", ""))
            {
                case "text": return v;
                case "slug": return Slug.IsMatch(v) ? v : null;
                case "username": return Username.IsMatch(v) ? v : null;
                case "station": return StationId.IsMatch(v) ? v : null;
                case "track": return TrackId.IsMatch(v) ? v : null;
                default: return null;
            }
        }

        /// <summary>The link, or null when it is not one (anything not allow-listed).</summary>
        public static ListenUri Parse(string input)
        {
            if (input == null || input.Length > 1024) return null;
            string rest = null;
            foreach (var scheme in new[] { "listen://", "web+listen://" })
            {
                if (StartsWithFolded(input, scheme))
                {
                    rest = input.Substring(scheme.Length);
                    // /^(listen|web\+listen):\/\/(.*)$/ : "." matches no line terminator
                    if (rest.IndexOfAny(new[] { '\n', '\r', '\u2028', '\u2029' }) >= 0) return null;
                    break;
                }
            }
            if (rest == null)
            {
                if (StartsWithFolded(input, HttpsBase)) rest = input.Substring(HttpsBase.Length);
                else return null;
            }
            if (rest.IndexOf('#') >= 0) return null;
            var q = rest.IndexOf('?');
            var path = q >= 0 ? rest.Substring(0, q) : rest;
            var query = q >= 0 ? rest.Substring(q + 1) : "";
            if (path.EndsWith("/", StringComparison.Ordinal)) path = path.Substring(0, path.Length - 1);
            var parts = path.Split('/').ToList();
            var target = TargetLower(parts[0]);
            parts.RemoveAt(0);
            string[] segs;
            if (target == null || !Segs.TryGetValue(target, out segs)) return null;
            var required = segs.Count(r => !r.EndsWith("?", StringComparison.Ordinal));
            if (parts.Count < required || parts.Count > segs.Length) return null;
            var o = new ListenUri { Target = target };
            for (int i = 0; i < parts.Count; i++)
            {
                var v = DecodeSeg(parts[i]);
                var ok = v == null ? null : CheckSeg(segs[i], v);
                if (ok == null) return null;
                o.SetField(Fields[target][i], ok);
            }
            if (query.Length > 0)
            {
                foreach (var pair in query.Split('&'))
                {
                    var kv = pair.Split('=');
                    var k = kv[0];
                    var v = kv.Length > 1 ? kv[1] : "";
                    if (target != "track" || k != "t" || o.T.HasValue) return null;
                    int n;
                    if (!Seconds.IsMatch(v) || !int.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out n) || n > 86400) return null;
                    o.T = n;
                }
            }
            return o.WithForms() ? o : null;
        }

        private bool WithForms()
        {
            var path = new StringBuilder(Target);
            foreach (var f in Fields[Target])
            {
                var v = Field(f);
                if (v == null) continue;
                var e = EncodeUriComponent(v);
                if (e == null) return false;
                path.Append('/').Append(e);
            }
            if (T.HasValue) path.Append("?t=").Append(T.Value.ToString(CultureInfo.InvariantCulture));
            Uri = "listen://" + path;
            Web = "web+listen://" + path;
            Https = HttpsBase + path;
            return true;
        }

        /// <summary>listenUri(): the link for a target and its fields, or null when it would not parse back.</summary>
        public static ListenUri Build(string target, string name = null, string station = null, string track = null,
            string land = null, string province = null, string user = null, int? t = null)
        {
            if (target == null || !Segs.ContainsKey(target)) return null;
            var o = new ListenUri { Target = target, Name = name, Station = station, Track = track, Land = land, Province = province, User = user, T = t };
            if (!o.WithForms()) return null;
            return Parse(o.Uri) != null ? o : null;
        }

        /// <summary>routeOf(): where spacegho.st sends this target, a path on <see cref="Site"/>.</summary>
        public string Route
        {
            get
            {
                switch (Target)
                {
                    case "artist": case "genre": return "/melodica/app/?seed=" + Target + ":" + EncodeUriComponent(Name);
                    case "station": return "/melodica/app/?station=" + EncodeUriComponent(Station);
                    case "track": return "/melodica/listens/?track=" + EncodeUriComponent(Track) + (T.HasValue ? "&t=" + T.Value.ToString(CultureInfo.InvariantCulture) : "");
                    case "map": return "/melodica/map/?land=" + EncodeUriComponent(Land) + (string.IsNullOrEmpty(Province) ? "" : "&province=" + EncodeUriComponent(Province));
                    case "user": return "/melodica/leaderboard/?user=" + EncodeUriComponent(User);
                    case "listens": return "/melodica/listens/";
                    case "leaderboard": return "/melodica/leaderboard/";
                    default: return "/melodica/";
                }
            }
        }
    }
}
