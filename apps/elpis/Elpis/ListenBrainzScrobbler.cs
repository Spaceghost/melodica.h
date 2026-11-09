/*
 * Elpis's ListenBrainz-compatible scrobbler, beside the Last.fm one: it watches play
 * progress like PandoraSharpScrobbler and reports through Elpis.Scrobbling.ListenBrainzClient
 * (ListenBrainz.cs). Network calls run off the UI thread, one at a time.
 */
using System;
using System.Net;
using System.Threading;
using PandoraSharp;
using PandoraSharp.ControlQuery;
using Util;

namespace Elpis.Scrobbling
{
    public class ListenBrainzScrobbler : IPlayerControlQuery
    {
        private readonly Func<Song> _currentSong;
        private readonly ListenRule _rule = new ListenRule();
        private readonly object _sendLock = new object();
        private ListenBrainzClient _client;
        private DateTime _startedUtc;
        private DateTime _lastRetryUtc = DateTime.MinValue;

        public ListenQueue Queue { get; private set; }
        public string ClientVersion { get; set; }

        public ListenBrainzScrobbler(Func<Song> currentSong, ListenQueue queue)
        {
            _currentSong = currentSong;
            Queue = queue;
            ClientVersion = "";
        }

        /// <summary>Turns scrobbling on (a server and a token) or off (null token).</summary>
        public void Configure(bool enabled, string server, string token, IWebProxy proxy)
        {
            if (!enabled || string.IsNullOrEmpty(token) || ListenBrainzServers.Normalize(server) == null)
            {
                _client = null;
                return;
            }
            _client = new ListenBrainzClient(server, token, Queue) { ClientVersion = ClientVersion, Proxy = proxy };
        }

        public bool IsEnabled { get { return _client != null; } }

        private static ListenTrack Describe(Song s)
        {
            var t = new ListenTrack { Artist = s.Artist ?? "", Title = s.SongTitle ?? "", Album = s.Album ?? "", ArtUrl = s.AlbumArtUrl };
            try
            {
                var station = s.Station;
                if (station != null) t.StationName = station.Name;
            }
            catch (Exception) { }
            return t;
        }

        private void Send(Action<ListenBrainzClient> call, string what)
        {
            var client = _client;
            if (client == null) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                lock (_sendLock)
                {
                    try { call(client); }
                    catch (ListenBrainzException e) { Log.O("ListenBrainz " + what + ": " + e.Message); }
                    catch (Exception e) { Log.O("ListenBrainz " + what + " failed: " + e.GetType().Name); }
                }
            });
        }

        public void ProgressUpdateReciever(QueryProgress progress)
        {
            if (_client == null || progress == null || progress.Progress == null) return;
            var song = _currentSong();
            if (song == null) return;
            var length = progress.Progress.TotalTime;
            var played = progress.Progress.ElapsedTime;
            if (_rule.Started(song))
            {
                _startedUtc = DateTime.UtcNow - played;
                var t = Describe(song);
                t.Length = length;
                Send(c => c.NowPlaying(t), "now playing");
            }
            if (_rule.Due(song, length, played))
            {
                var t = Describe(song);
                t.Length = length;
                var at = _startedUtc;
                Send(c => c.Listen(t, at), "listen");
            }
            else if (Queue.Count > 0 && DateTime.UtcNow - _lastRetryUtc > TimeSpan.FromMinutes(5))
            {
                _lastRetryUtc = DateTime.UtcNow;
                Send(c => c.TryFlush(), "queue");
            }
        }

        /// <summary>validate-token on a background thread; done gets (valid, user) or an error message.</summary>
        public static void Check(string server, string token, IWebProxy proxy, Action<bool, string, string> done)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    var c = new ListenBrainzClient(server, token) { Proxy = proxy };
                    string user;
                    var valid = c.Validate(out user);
                    done(valid, user, null);
                }
                catch (ListenBrainzException e) { done(false, null, e.Message); }
                catch (ArgumentException e) { done(false, null, e.Message); }
                catch (Exception e) { done(false, null, "The server could not be checked (" + e.GetType().Name + ")."); }
            });
        }

        #region IPlayerControlQuery Members

        public event PlayStateRequestEvent PlayStateRequest;
        public event PlayRequestEvent PlayRequest;
        public event PauseRequestEvent PauseRequest;
        public event NextRequestEvent NextRequest;
        public event StopRequestEvent StopRequest;
        public event SetSongMetaRequestEvent SetSongMetaRequest;

        public void SongUpdateReceiver(QuerySong song) { }
        public void StatusUpdateReceiver(QueryStatus status) { }
        public void RatingUpdateReceiver(QuerySong song, SongRating oldRating, SongRating newRating) { }

        #endregion
    }
}
