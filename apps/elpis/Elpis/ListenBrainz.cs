/*
 * ListenBrainz-compatible scrobbling: spacegho.st's scrobble service by default
 * (https://spacegho.st/scrobble, tokens from https://spacegho.st/melodica/account/), or
 * listenbrainz.org, or any server with the same API under {base}/1/.
 *
 * Plain C# 7.3 with no JSON library, so the same file builds into Elpis (.NET Framework 4.6)
 * and into the host tests. The token goes only into the Authorization header; it never
 * appears in a log line, an exception message or the queue file.
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Elpis.Scrobbling
{
    public static class ListenBrainzServers
    {
        public const string SpaceGhost = "https://spacegho.st/scrobble";
        public const string ListenBrainzOrg = "https://api.listenbrainz.org";
        public const string SpaceGhostTokens = "https://spacegho.st/melodica/account/";

        /// <summary>The base URL without a trailing slash, or null when it is not an http(s) URL.</summary>
        public static string Normalize(string url)
        {
            var u = (url ?? "").Trim().TrimEnd('/');
            if (u.Length == 0) return SpaceGhost;
            Uri parsed;
            if (!Uri.TryCreate(u, UriKind.Absolute, out parsed) || (parsed.Scheme != "https" && parsed.Scheme != "http")
                || parsed.UserInfo.Length > 0 || parsed.Query.Length > 0 || parsed.Fragment.Length > 0)
                return null;
            return u;
        }
    }

    /// <summary>What is known about the song that plays.</summary>
    public class ListenTrack
    {
        public string Artist = "";
        public string Title = "";
        public string Album = "";
        public string ArtUrl;
        public string StationName;
        public TimeSpan Length;
    }

    public class ListenBrainzException : Exception
    {
        public int Status { get; private set; }
        public ListenBrainzException(int status, string message) : base(message) { Status = status; }
    }

    public static class ListenJson
    {
        public static string Str(string s)
        {
            var b = new StringBuilder("\"");
            foreach (var c in s ?? "")
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
                        else b.Append(c);
                        break;
                }
            }
            return b.Append('"').ToString();
        }

        /// <summary>One listen: {"listened_at"?, "track_metadata": {...}}.</summary>
        public static string Listen(ListenTrack t, long? listenedAt, string clientVersion)
        {
            var info = new List<string>
            {
                "\"media_player\":\"Elpis\"",
                "\"submission_client\":\"Elpis\"",
                "\"music_service\":\"pandora.com\"",
                "\"music_service_name\":\"Pandora\"",
            };
            if (!string.IsNullOrEmpty(clientVersion))
            {
                info.Add("\"submission_client_version\":" + Str(clientVersion));
                info.Add("\"media_player_version\":" + Str(clientVersion));
            }
            if (t.Length > TimeSpan.Zero)
                info.Add("\"duration_ms\":" + ((long)t.Length.TotalMilliseconds).ToString(CultureInfo.InvariantCulture));
            // Exactly as Pandora gives it, http or https: the scrobble service keeps a cached copy.
            if (!string.IsNullOrEmpty(t.ArtUrl) && (t.ArtUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || t.ArtUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
                info.Add("\"art_url\":" + Str(t.ArtUrl));
            if (!string.IsNullOrEmpty(t.StationName))
                info.Add("\"station_name\":" + Str(t.StationName));
            var meta = "\"artist_name\":" + Str(t.Artist) + ",\"track_name\":" + Str(t.Title);
            if (!string.IsNullOrEmpty(t.Album))
                meta += ",\"release_name\":" + Str(t.Album);
            meta += ",\"additional_info\":{" + string.Join(",", info) + "}";
            var head = listenedAt.HasValue ? "\"listened_at\":" + listenedAt.Value.ToString(CultureInfo.InvariantCulture) + "," : "";
            return "{" + head + "\"track_metadata\":{" + meta + "}}";
        }

        public static string Submission(string listenType, IEnumerable<string> listens)
        {
            return "{\"listen_type\":" + Str(listenType) + ",\"payload\":[" + string.Join(",", listens) + "]}";
        }
    }

    /// <summary>
    /// Listens that could not be sent (offline, a timeout, 401, 429 or 5xx), one per line as
    /// "server TAB listen-json", oldest first. Sent again as a ListenBrainz import (at most 100 at a
    /// time) at the next contact. A 400 drops the listen. Holds no token.
    /// </summary>
    public class ListenQueue
    {
        private readonly object _lock = new object();
        private readonly string _path;
        private readonly int _capacity;

        public ListenQueue(string path, int capacity = 1000)
        {
            _path = path;
            _capacity = capacity;
        }

        private List<KeyValuePair<string, string>> Load()
        {
            var list = new List<KeyValuePair<string, string>>();
            try
            {
                if (File.Exists(_path))
                    foreach (var line in File.ReadAllLines(_path, Encoding.UTF8))
                    {
                        var tab = line.IndexOf('\t');
                        if (tab > 0 && line.Length > tab + 1 && line[tab + 1] == '{')
                            list.Add(new KeyValuePair<string, string>(line.Substring(0, tab), line.Substring(tab + 1)));
                    }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return list;
        }

        private void Save(List<KeyValuePair<string, string>> list)
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(_path));
            if (dir != null) Directory.CreateDirectory(dir);
            var tmp = _path + ".tmp";
            File.WriteAllLines(tmp, list.Select(kv => kv.Key + "\t" + kv.Value), new UTF8Encoding(false));
            if (File.Exists(_path)) File.Delete(_path);
            File.Move(tmp, _path);
        }

        public int Count { get { lock (_lock) return Load().Count; } }

        public int CountFor(string server) { lock (_lock) return Load().Count(kv => kv.Key == server); }

        public void Add(string server, string listenJson)
        {
            lock (_lock)
            {
                var list = Load();
                list.Add(new KeyValuePair<string, string>(server, listenJson));
                if (list.Count > _capacity) list.RemoveRange(0, list.Count - _capacity);
                Save(list);
            }
        }

        /// <summary>The oldest (at most max) listens for server.</summary>
        public List<string> Peek(string server, int max)
        {
            lock (_lock) return Load().Where(kv => kv.Key == server).Take(max).Select(kv => kv.Value).ToList();
        }

        public void Remove(string server, IEnumerable<string> listens)
        {
            lock (_lock)
            {
                var list = Load();
                foreach (var l in listens)
                {
                    var i = list.FindIndex(kv => kv.Key == server && kv.Value == l);
                    if (i >= 0) list.RemoveAt(i);
                }
                Save(list);
            }
        }
    }

    public class ListenBrainzClient
    {
        private readonly string _token;
        private readonly ListenQueue _queue;
        private readonly object _flushLock = new object();

        public string Server { get; private set; }
        public string ClientVersion { get; set; }
        public IWebProxy Proxy { get; set; }
        public int TimeoutMs { get; set; }

        public ListenBrainzClient(string server, string token, ListenQueue queue = null)
        {
            var s = ListenBrainzServers.Normalize(server);
            if (s == null) throw new ArgumentException("The ListenBrainz server must be an http(s) URL.");
            Server = s;
            _token = token ?? "";
            _queue = queue;
            ClientVersion = "";
            TimeoutMs = 30000;
            try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch (NotSupportedException) { }
        }

        /// <summary>Statuses whose listen is kept for later: no answer (0), 401, 408, 429 and 5xx.</summary>
        public static bool Keeps(int status) { return status == 0 || status == 401 || status == 408 || status == 429 || status >= 500; }

        public static string Describe(int status)
        {
            if (status == 0) return "The ListenBrainz server could not be reached.";
            if (status == 401) return "The ListenBrainz server rejected the token; set a new one in Settings.";
            return "The ListenBrainz server answered " + status.ToString(CultureInfo.InvariantCulture) + ".";
        }

        /// <summary>HTTP status of the request, or 0 when there was no answer. Never throws for HTTP errors.</summary>
        private int Send(string method, string path, string body, out string answer)
        {
            answer = "";
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Server + path);
                req.Method = method;
                req.Timeout = TimeoutMs;
                req.ReadWriteTimeout = TimeoutMs;
                req.Accept = "application/json";
                req.UserAgent = "Elpis (melodica) " + ClientVersion;
                if (Proxy != null) req.Proxy = Proxy;
                req.Headers[HttpRequestHeader.Authorization] = "Token " + _token;
                if (body != null)
                {
                    var bytes = new UTF8Encoding(false).GetBytes(body);
                    req.ContentType = "application/json";
                    req.ContentLength = bytes.Length;
                    using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                }
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    answer = r.ReadToEnd();
                    return (int)res.StatusCode;
                }
            }
            catch (WebException e)
            {
                var res = e.Response as HttpWebResponse;
                if (res == null) return 0;
                using (res) return (int)res.StatusCode;
            }
            catch (IOException) { return 0; }
        }

        private int Post(string listenType, IEnumerable<string> listens)
        {
            string answer;
            return Send("POST", "/1/submit-listens", ListenJson.Submission(listenType, listens), out answer);
        }

        public void NowPlaying(ListenTrack t)
        {
            TryFlush();
            var status = Post("playing_now", new[] { ListenJson.Listen(t, null, ClientVersion) });
            if (status < 200 || status >= 300) throw new ListenBrainzException(status, Describe(status));
        }

        /// <summary>Submits a listen; on a failure that may pass, it is queued and the exception says so.</summary>
        public void Listen(ListenTrack t, DateTime startedUtc)
        {
            TryFlush();
            var at = (long)(startedUtc.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
            var listen = ListenJson.Listen(t, at, ClientVersion);
            var status = Post("single", new[] { listen });
            if (status >= 200 && status < 300) return;
            if (_queue != null && Keeps(status))
            {
                _queue.Add(Server, listen);
                throw new ListenBrainzException(status, Describe(status) + " The listen is queued and will be sent again.");
            }
            throw new ListenBrainzException(status, Describe(status));
        }

        /// <summary>Sends what is queued for this server; false when some stay queued.</summary>
        public bool TryFlush()
        {
            if (_queue == null) return true;
            lock (_flushLock)
            {
                while (true)
                {
                    var batch = _queue.Peek(Server, 100);
                    if (batch.Count == 0) return true;
                    var status = Post("import", batch);
                    if (status == 400 && batch.Count > 1)
                    {
                        // One bad listen must not hold back the rest.
                        foreach (var one in batch)
                        {
                            var s1 = Post("import", new[] { one });
                            if (Keeps(s1)) return false;
                            _queue.Remove(Server, new[] { one });
                        }
                        continue;
                    }
                    if (Keeps(status)) return false;
                    _queue.Remove(Server, batch);
                }
            }
        }

        /// <summary>validate-token: whether the server knows the token, and its user name.</summary>
        public bool Validate(out string userName)
        {
            userName = null;
            string answer;
            var status = Send("GET", "/1/validate-token", null, out answer);
            if (status < 200 || status >= 300) throw new ListenBrainzException(status, Describe(status));
            var m = Regex.Match(answer, "\"user_name\"\\s*:\\s*\"([^\"\\\\]*)\"");
            if (m.Success) userName = m.Groups[1].Value;
            return Regex.IsMatch(answer, "\"valid\"\\s*:\\s*true");
        }
    }

    /// <summary>When a listen counts: longer than 30 s, played half its length or 4 minutes, once per play.</summary>
    public class ListenRule
    {
        private object _playing;
        private bool _reported;

        public static bool Counts(TimeSpan length, TimeSpan played)
        {
            return length > TimeSpan.FromSeconds(30) && played >= TimeSpan.FromTicks(Math.Min(length.Ticks / 2, TimeSpan.FromMinutes(4).Ticks));
        }

        /// <summary>True when play is a new play (now playing is due).</summary>
        public bool Started(object play)
        {
            if (ReferenceEquals(play, _playing)) return false;
            _playing = play;
            _reported = false;
            return true;
        }

        public bool Due(object play, TimeSpan length, TimeSpan played)
        {
            Started(play);
            if (_reported || !Counts(length, played)) return false;
            _reported = true;
            return true;
        }
    }
}
