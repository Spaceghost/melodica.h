// ListenBrainz-compatible scrobbling (spacegho.st by default). Plain Dart: dart:async and
// dart:convert only, so tool/scrobble_test.dart runs it without Flutter. The HTTP transport and
// the queue's storage are passed in (package:http and SharedPreferences in the app).
//
// The token only ever goes into the Authorization header: never into a message, exception or log.
import 'dart:async';
import 'dart:convert';

const String spaceghostScrobbleBase = 'https://spacegho.st/scrobble';
const String listenBrainzBase = 'https://api.listenbrainz.org';

class ScrobbleResponse {
  /// The HTTP status, or -1 when there was no answer (offline, timeout).
  final int status;
  final String body;
  const ScrobbleResponse(this.status, [this.body = '']);
  bool get ok => status >= 200 && status < 300;
}

typedef ScrobbleTransport = Future<ScrobbleResponse> Function(String method, Uri url, Map<String, String> headers, String body);

/// When a listen counts (Last.fm's rule, which ListenBrainz follows): the song is longer than
/// 30 seconds and has played for half its length or four minutes, whichever comes first.
bool scrobbleCounts(Duration length, Duration played) {
  if (length == null || length <= const Duration(seconds: 30)) return false;
  final half = Duration(microseconds: length.inMicroseconds ~/ 2);
  final need = half < const Duration(minutes: 4) ? half : const Duration(minutes: 4);
  return played >= need;
}

/// One play of one Pandora song.
class ScrobbleListen {
  final String artist, track, album, artUrl, station;
  final Duration duration; // null when unknown
  final DateTime startedAt;

  ScrobbleListen({this.artist, this.track, this.album, this.artUrl, this.station, this.duration, DateTime startedAt})
      : startedAt = startedAt ?? DateTime.now();

  bool get isSong => (artist ?? '').trim().isNotEmpty && (track ?? '').trim().isNotEmpty;

  /// A payload entry: track_metadata, plus listened_at unless this is playing_now.
  Map<String, dynamic> toJson({bool withTimestamp, String client, String version}) {
    final info = <String, dynamic>{
      'submission_client': client,
      'submission_client_version': version,
      'media_player': client,
      'music_service': 'pandora.com',
      'music_service_name': 'Pandora',
    };
    if (duration != null && duration > Duration.zero) info['duration_ms'] = duration.inMilliseconds;
    if (artUrl != null && (artUrl.startsWith('http://') || artUrl.startsWith('https://'))) info['art_url'] = artUrl;
    if (station != null && station.isNotEmpty) info['station_name'] = station;
    final meta = <String, dynamic>{'artist_name': artist, 'track_name': track};
    if (album != null && album.isNotEmpty) meta['release_name'] = album;
    meta['additional_info'] = info;
    return {
      if (withTimestamp) 'listened_at': startedAt.millisecondsSinceEpoch ~/ 1000,
      'track_metadata': meta,
    };
  }
}

/// Where queued listens (JSON payload entries, oldest first) are kept between runs.
abstract class ListenStore {
  Future<List<String>> load();
  Future<void> save(List<String> entries);
}

class MemoryListenStore implements ListenStore {
  List<String> entries = <String>[];
  @override
  Future<List<String>> load() async => List<String>.from(entries);
  @override
  Future<void> save(List<String> e) async => entries = List<String>.from(e);
}

class ListenBrainzClient {
  final String base;
  final String _token;
  final ScrobbleTransport transport;

  ListenBrainzClient(String base, String token, this.transport)
      : base = _trim((base == null || base.trim().isEmpty) ? spaceghostScrobbleBase : base.trim()),
        _token = (token ?? '').trim();

  static String _trim(String b) {
    while (b.endsWith('/')) b = b.substring(0, b.length - 1);
    return b;
  }

  bool get configured => _token.isNotEmpty;

  Map<String, String> get _headers => {'Authorization': 'Token $_token', 'Accept': 'application/json', 'Content-Type': 'application/json'};

  Future<ScrobbleResponse> _call(String method, String path, String body) async {
    try {
      return await transport(method, Uri.parse('$base$path'), _headers, body).timeout(const Duration(seconds: 30));
    } catch (_) {
      return const ScrobbleResponse(-1); // the error text could carry request details; drop it
    }
  }

  Future<int> submit(String listenType, List<String> entries) async {
    final body = '{"listen_type":${jsonEncode(listenType)},"payload":[${entries.join(',')}]}';
    return (await _call('POST', '/1/submit-listens', body)).status;
  }

  /// true: the server accepts the token; false: it refuses it; null: no answer.
  Future<bool> validate() async {
    final r = await _call('GET', '/1/validate-token', null);
    if (r.status == 401) return false;
    if (!r.ok) return null;
    try {
      return (jsonDecode(r.body) as Map)['valid'] == true;
    } catch (_) {
      return null;
    }
  }
}

/// playing_now when a song starts; one single listen once it counts. Listens that fail (no
/// answer, 401, 429, 5xx) wait in the store and go out oldest first as imports on the next
/// contact. 400 means the listen itself is unacceptable: it is dropped. Calls run one at a time.
class Scrobbler {
  static const int maxQueued = 1000;
  final ListenStore store;
  final ScrobbleTransport transport;
  final String client, version;
  final void Function(String message) onStatus;
  ListenBrainzClient _api;
  ScrobbleListen _current;
  bool _reported = false;
  Future<void> _chain = Future<void>.value();

  Scrobbler({this.store, this.transport, this.client, this.version, this.onStatus});

  void configure(String base, String token) => _api = ListenBrainzClient(base, token, transport);

  bool get configured => _api != null && _api.configured;

  Future<void> _run(Future<void> Function() job) => _chain = _chain.then((_) => job()).catchError((_) {});

  /// Waits for the calls already started.
  Future<void> idle() => _chain;

  Future<void> started(ScrobbleListen listen) {
    _current = listen;
    _reported = false;
    return _run(() async {
      if (!configured || !listen.isSong) return;
      final s = await _api.submit('playing_now', [jsonEncode(listen.toJson(withTimestamp: false, client: client, version: version))]);
      if (s == 401) _say('The scrobble token was refused; check it in Scrobbling settings.');
      if (s >= 200 && s < 300) await _flush();
    });
  }

  /// played: how long the current song has actually played (seeking does not count).
  Future<void> progress(Duration played, {Duration length}) {
    final l = _current;
    if (l == null || _reported || !l.isSong) return _chain;
    final len = length ?? l.duration;
    if (!scrobbleCounts(len, played)) return _chain;
    _reported = true;
    final listen = ScrobbleListen(artist: l.artist, track: l.track, album: l.album, artUrl: l.artUrl, station: l.station, duration: len, startedAt: l.startedAt);
    return _run(() async {
      if (!configured) return;
      final entry = jsonEncode(listen.toJson(withTimestamp: true, client: client, version: version));
      final s = await _api.submit('single', [entry]);
      if (s >= 200 && s < 300) {
        await _flush();
      } else if (s != 400) {
        final q = await store.load();
        q.add(entry);
        await store.save(q.length > maxQueued ? q.sublist(q.length - maxQueued) : q);
        if (s == 401) _say('The scrobble token was refused; the listen is kept until it works.');
      }
    });
  }

  /// Sends queued listens now (e.g. when playback starts).
  Future<void> retry() => _run(() async {
        if (configured) await _flush();
      });

  Future<void> _flush() async {
    var q = await store.load();
    while (q.isNotEmpty) {
      final n = q.length < 100 ? q.length : 100;
      final s = await _api.submit('import', q.sublist(0, n));
      if (!(s >= 200 && s < 300) && s != 400) return;
      q = q.sublist(n);
      await store.save(q);
    }
  }

  void _say(String m) {
    if (onStatus != null) onStatus(m);
  }
}
