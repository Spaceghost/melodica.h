// Which of the user's stations a listen:// link means. Plain Dart (tool/listen_uri_test.dart).
import 'package:epimetheus/listen/listen_uri.dart';

String _norm(String s) => s.trim().replaceAll(RegExp(r'\s+'), ' ').toLowerCase();

/// The index in [ids]/[names] of the station a station, artist or genre link names, or -1.
/// station/<id>: that station id. artist/genre <name>: a station called "<name>" or
/// "<name> Radio" (case-insensitive).
int matchStation(ListenUri link, List<String> ids, List<String> names) {
  if (link.target == 'station') return ids.indexOf(link['station']);
  if (link.target != 'artist' && link.target != 'genre') return -1;
  final want = _norm(link['name']);
  for (var i = 0; i < names.length; i++) {
    final n = _norm(names[i] ?? '');
    if (n == want || n == '$want radio') return i;
  }
  return -1;
}
