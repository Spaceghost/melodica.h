// The app side of lib/scrobble/listenbrainz.dart: settings (server in SharedPreferences, token in
// secure storage like the Pandora credentials), the package:http transport and the queue store.
import 'package:epimetheus/scrobble/listenbrainz.dart';
import 'package:epimetheus/storage/secure_storage_manager.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const String scrobbleClient = 'Epimetheus';
const String scrobbleClientVersion = '0.1.0';

const String _enabledKey = 'scrobble_enabled';
const String _serverKey = 'scrobble_server';
const String _tokenKey = 'scrobble_token';
const String _queueKey = 'scrobble_queue';

class ScrobbleConfig {
  final bool enabled;
  final String server;
  final String token;
  const ScrobbleConfig({this.enabled = true, this.server = spaceghostScrobbleBase, this.token = ''});

  /// What the audio task uses: an empty token turns scrobbling off.
  String get activeToken => enabled ? token : '';
}

Future<ScrobbleConfig> loadScrobbleConfig() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final storage = await getPlatformSecureStorageManager();
    return ScrobbleConfig(
      enabled: prefs.getBool(_enabledKey) ?? true,
      server: prefs.getString(_serverKey) ?? spaceghostScrobbleBase,
      token: (await storage.read(_tokenKey)) ?? '',
    );
  } catch (_) {
    return const ScrobbleConfig(token: '');
  }
}

Future<void> saveScrobbleConfig(ScrobbleConfig c) async {
  final prefs = await SharedPreferences.getInstance();
  final storage = await getPlatformSecureStorageManager();
  await prefs.setBool(_enabledKey, c.enabled);
  await prefs.setString(_serverKey, c.server);
  if (c.token.isEmpty) {
    await storage.delete(_tokenKey);
  } else {
    await storage.write(_tokenKey, c.token);
  }
}

Future<ScrobbleResponse> httpScrobbleTransport(String method, Uri url, Map<String, String> headers, String body) async {
  final r = method == 'POST' ? await http.post(url, headers: headers, body: body) : await http.get(url, headers: headers);
  return ScrobbleResponse(r.statusCode, r.body);
}

/// Queued listens in SharedPreferences (works on every platform, including the web).
class PrefsListenStore implements ListenStore {
  List<String> _memory = <String>[];

  @override
  Future<List<String>> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return List<String>.from(prefs.getStringList(_queueKey) ?? const <String>[]);
    } catch (_) {
      return List<String>.from(_memory);
    }
  }

  @override
  Future<void> save(List<String> entries) async {
    _memory = List<String>.from(entries);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_queueKey, entries);
    } catch (_) {
      // kept in memory for this run
    }
  }
}
