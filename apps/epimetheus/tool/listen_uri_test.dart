// The cases of melodica-scrobble tests/listen-uri.test.mjs, ported one for one, for
// lib/listen/listen_uri.dart. With --canon, reads one \uXXXX-escaped input per line on stdin and
// prints the canonical parse (compared with the reference parser in CI and on bak).
// Run from the app root after `flutter pub get`: dart tool/listen_uri_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:epimetheus/listen/listen_uri.dart';
import 'package:epimetheus/listen/station_match.dart';

var failures = 0;
void check(bool ok, String what) {
  if (!ok) {
    print('FAIL $what');
    failures++;
  }
}

Future<void> main(List<String> args) async {
  if (args.isNotEmpty && args[0] == '--canon') return canon();
  final a64 = 'a' * 64;
  final cases = <String, Map<String, Object>>{
    'listen://artist/Modest%20Mouse': {'target': 'artist', 'name': 'Modest Mouse'},
    'web+listen://genre/thrash%20metal': {'target': 'genre', 'name': 'thrash metal'},
    'https://spacegho.st/listen/station/4123456789012345': {'target': 'station', 'station': '4123456789012345'},
    'listen://track/$a64?t=95': {'target': 'track', 'track': a64, 't': 95},
    'listen://map/neon-plains/synthwave-reach': {'target': 'map', 'land': 'neon-plains', 'province': 'synthwave-reach'},
    'listen://map/neon-plains': {'target': 'map', 'land': 'neon-plains'},
    'listen://user/knewter': {'target': 'user', 'username': 'knewter'},
    'listen://listens': {'target': 'listens'},
    'LISTEN://Leaderboard/': {'target': 'leaderboard'},
    'listen://artist/Sigur%20R%C3%B3s': {'target': 'artist', 'name': 'Sigur Rós'},
  };
  cases.forEach((u, want) {
    final p = ListenUri.parse(u);
    check(p != null, u);
    if (p == null) return;
    want.forEach((k, v) => check((k == 'target' ? p.target : k == 't' ? p.t : p[k]) == v, '$u $k'));
    check(ListenUri.parse(p.https).uri == p.uri, 'https round trip $u');
    check(ListenUri.parse(p.web).uri == p.uri, 'web+ round trip $u');
  });
  check(ListenUri.parse('listen://artist/AC%2FDC') == null, 'no slash inside a name');
  check(ListenUri.build('artist', {'name': "Guns N' Roses"}).https == "https://spacegho.st/listen/artist/Guns%20N'%20Roses", 'build https');
  check(ListenUri.parse(ListenUri.build('artist', {'name': "Guns N' Roses"}).uri)['name'] == "Guns N' Roses", 'build round trip');

  final bad = <Object>[
    'listen://http://evil.example', 'listen://url/https%3A%2F%2Fevil.example', 'listen://artist', 'listen://artist/a/b',
    'listen://artist/%00x', 'listen://artist/%2e%2e', 'listen://artist/${'x' * 201}', 'listen://artist/%E0%A4%A',
    'listen://artist/ x', 'listen://artist/x?autoplay=1', 'listen://track/zzz!?t=1', 'listen://track/abc?t=999999',
    'listen://track/abc?t=1&t=2', 'listen://map/Neon_Plains', 'listen://map/a/b/c', 'listen://user/A', 'listen://station/12-34',
    'listen://artist/x#frag', 'javascript:alert(1)', 'https://evil.example/listen/artist/x', 'https://spacegho.st/listen/../oauth/admin',
    'listen://listens/extra', 'listen://artist/<script>', 42, null,
  ];
  for (final u in bad) check(ListenUri.parse(u) == null, 'rejects $u');
  check(ListenUri.build('url', {'name': 'x'}) == null, 'no url target');
  check(ListenUri.build('artist', {'name': '..'}) == null, '.. is not a name');
  check(ListenUri.build('artist', {'name': '...'}) != null, 'three dots is a name');
  check(ListenUri.build('user', {'username': 'NO'}) == null, 'uppercase username');

  check(ListenUri.parse('listen://artist/Modest%20Mouse').route == '/melodica/app/?seed=artist:Modest%20Mouse', 'route artist');
  check(ListenUri.parse('listen://map/neon-plains/synthwave-reach').route == '/melodica/map/?land=neon-plains&province=synthwave-reach', 'route map');
  check(ListenUri.parse('listen://track/abc?t=5').route == '/melodica/listens/?track=abc&t=5', 'route track');
  for (final u in ['listen://listens', 'listen://leaderboard', 'listen://user/knewter', 'listen://station/123', 'listen://genre/dance']) {
    check(ListenUri.parse(u).route.startsWith('/melodica/'), 'route $u');
  }
  // Which station a link selects (the app asks before it plays).
  final ids = ['111', '222', '333'], names = ['QuickMix', 'Aurora Fields Radio', 'thrash metal'];
  check(matchStation(ListenUri.parse('listen://station/222'), ids, names) == 1, 'station by id');
  check(matchStation(ListenUri.parse('listen://station/999'), ids, names) == -1, 'unknown station');
  check(matchStation(ListenUri.parse('listen://artist/aurora%20fields'), ids, names) == 1, 'artist -> "<name> Radio"');
  check(matchStation(ListenUri.parse('listen://genre/Thrash%20Metal'), ids, names) == 2, 'genre -> "<name>"');
  check(matchStation(ListenUri.parse('listen://artist/Nobody'), ids, names) == -1, 'no match');
  check(matchStation(ListenUri.parse('listen://listens'), ids, names) == -1, 'not a station target');
  print(failures == 0 ? 'PASS listen-uri' : '$failures FAILED');
  exit(failures == 0 ? 0 : 1);
}

Future<void> canon() async {
  final un = RegExp(r'\\u([0-9a-f]{4})');
  final out = StringBuffer();
  await for (final line in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    final p = ListenUri.parse(line.replaceAllMapped(un, (m) => String.fromCharCode(int.parse(m.group(1), radix: 16))));
    if (p == null) {
      out.writeln('null');
      continue;
    }
    final keys = p.fields.keys.toList()..sort();
    out.writeln('${p.target}|{${keys.map((k) => '$k=${p.fields[k]}').join(', ')}}|${p.t}|${p.uri}|${p.https}|${p.route}');
  }
  stdout.add(utf8.encode(out.toString()));
  await stdout.flush();
}
