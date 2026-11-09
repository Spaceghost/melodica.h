// Plain-Dart checks of lib/scrobble/listenbrainz.dart (no Flutter): the rule, the payload, and a
// run against tool/fake_lb.py. tool/scrobble_test.sh runs it: dart tool/scrobble_test.dart BASE TOKEN LOG
import 'dart:convert';
import 'dart:io';

import '../lib/scrobble/listenbrainz.dart';

var failures = 0;
void check(bool ok, String what) {
  print('${ok ? 'ok  ' : 'FAIL'} $what');
  if (!ok) failures++;
}

Future<ScrobbleResponse> ioTransport(String method, Uri url, Map<String, String> headers, String body) async {
  final c = HttpClient();
  try {
    final req = await c.openUrl(method, url);
    headers.forEach(req.headers.set);
    if (body != null) {
      final bytes = utf8.encode(body);
      req.contentLength = bytes.length; // fake_lb.py, like most servers, wants a length, not chunks
      req.add(bytes);
    }
    final res = await req.close();
    return ScrobbleResponse(res.statusCode, await res.transform(utf8.decoder).join());
  } finally {
    c.close();
  }
}

Future<void> main(List<String> args) async {
  check(!scrobbleCounts(const Duration(seconds: 30), const Duration(seconds: 30)), '30 s songs never count');
  check(scrobbleCounts(const Duration(seconds: 31), const Duration(milliseconds: 15500)), 'half of a short song counts');
  check(!scrobbleCounts(const Duration(seconds: 31), const Duration(milliseconds: 15499)), 'less than half does not');
  check(scrobbleCounts(const Duration(minutes: 10), const Duration(minutes: 4)), '4 minutes of a long song counts');
  check(!scrobbleCounts(const Duration(minutes: 10), const Duration(seconds: 239)), 'under 4 minutes does not');
  check(!scrobbleCounts(null, const Duration(minutes: 9)), 'unknown length never counts');

  final at = DateTime.fromMillisecondsSinceEpoch(1762600000 * 1000);
  final l = ScrobbleListen(artist: 'Test Artist', track: 'melodica-client-test epimetheus', album: 'LP', artUrl: 'http://cont.p-cdn.us/images/a.jpg', station: 'Test Radio', duration: const Duration(seconds: 200), startedAt: at);
  final j = l.toJson(withTimestamp: true, client: 'Epimetheus', version: '0.1.0');
  final info = j['track_metadata']['additional_info'];
  check(j['listened_at'] == 1762600000, 'single has listened_at');
  check(!l.toJson(withTimestamp: false, client: 'E', version: '1').containsKey('listened_at'), 'playing_now has none');
  check(info['art_url'] == 'http://cont.p-cdn.us/images/a.jpg', 'art_url as Pandora gives it (http)');
  check(info['station_name'] == 'Test Radio' && info['duration_ms'] == 200000 && info['music_service'] == 'pandora.com' && info['music_service_name'] == 'Pandora', 'station, duration, service');
  check(!jsonEncode(j).contains('pandora_'), 'no Pandora ids');
  if (args.isEmpty) return exit(failures == 0 ? 0 : 1);

  final base = args[0], token = args[1], log = File(args[2]);
  final store = MemoryListenStore();
  final said = <String>[];
  final s = Scrobbler(store: store, transport: ioTransport, client: 'Epimetheus', version: 'test', onStatus: said.add);
  s.configure(base, token);
  final now = DateTime.now();
  // fake_lb --fail 2: the first playing_now and the first single get 503
  await s.started(ScrobbleListen(artist: 'Test Artist', track: 'melodica-client-test epimetheus one', album: 'LP', artUrl: 'http://cont.p-cdn.us/a.jpg', station: 'Test Radio', duration: const Duration(seconds: 200), startedAt: now.subtract(const Duration(seconds: 300))));
  await s.progress(const Duration(seconds: 99));
  await s.progress(const Duration(seconds: 100));
  await s.progress(const Duration(seconds: 150)); // already reported
  check(store.entries.length == 1, 'failed listen queued');
  await s.started(ScrobbleListen(artist: 'Test Artist', track: 'melodica-client-test epimetheus two', duration: const Duration(seconds: 180), startedAt: now.subtract(const Duration(seconds: 100))));
  await s.progress(const Duration(seconds: 90));
  await s.idle();
  check(store.entries.isEmpty, 'queue empty after retry');
  final text = await log.readAsString();
  final seq = [for (final line in text.trim().split('\n')) '${jsonDecode(line)['listen_type']}:${jsonDecode(line)['status']}'].join(' ');
  print('     server saw: $seq');
  check(seq == 'playing_now:503 single:503 playing_now:200 import:200 single:200', 'playing_now, single, queue after failure, retry as import');
  final queued = jsonDecode(text.trim().split('\n')[3])['payload'][0];
  check(queued['listened_at'] == now.millisecondsSinceEpoch ~/ 1000 - 300 && queued['track_metadata']['track_name'] == 'melodica-client-test epimetheus one', 'queued listen kept its time');
  check(!text.contains(token), "token not in the server's log");
  check(said.isEmpty, 'no status messages');

  final store2 = MemoryListenStore();
  final said2 = <String>[];
  final bad = Scrobbler(store: store2, transport: ioTransport, client: 'Epimetheus', version: 'test', onStatus: said2.add);
  bad.configure(base, 'sgs_wrong');
  await bad.started(ScrobbleListen(artist: 'Test Artist', track: 'melodica-client-test epimetheus bad', duration: const Duration(seconds: 100)));
  await bad.progress(const Duration(seconds: 60));
  check(store2.entries.length == 1, 'listen kept when the token is refused');
  check(said2.isNotEmpty && !said2.join().contains('sgs_'), 'user told, token not shown');
  check(await ListenBrainzClient(base, token, ioTransport).validate() == true, 'validate-token: valid');
  check(await ListenBrainzClient(base, 'sgs_wrong', ioTransport).validate() == false, 'validate-token: invalid');
  final offline = Scrobbler(store: MemoryListenStore(), transport: ioTransport, client: 'E', version: 't');
  offline.configure('http://127.0.0.1:9', token);
  await offline.started(ScrobbleListen(artist: 'A', track: 'T', duration: const Duration(seconds: 100)));
  await offline.progress(const Duration(seconds: 60));
  check((offline.store as MemoryListenStore).entries.length == 1, 'queued when offline');
  print(failures == 0 ? 'PASS' : '$failures FAILED');
  exit(failures == 0 ? 0 : 1);
}
