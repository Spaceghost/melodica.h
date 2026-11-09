// listen:// links (melodica-scrobble docs/LISTEN-URI.md): a port of the reference parser
// src/listen-uri.js. It accepts and rejects exactly what tests/listen-uri.test.mjs pins
// (tool/listen_uri_test.dart). Plain Dart plus unorm_dart for NFC. Parsing never plays
// anything: the app asks first.
import 'dart:convert';

import 'package:unorm_dart/unorm_dart.dart' as unorm;

const String listenHttpsBase = 'https://spacegho.st/listen/';
const String listenSite = 'https://spacegho.st';
const int _maxText = 200;

final _scheme = RegExp(r'^(listen|web\+listen):\/\/(.*)$', caseSensitive: false);
final _rawSeg = RegExp(r"^[A-Za-z0-9\-._~%!$&'()*+,;=:@]*$");
final _slug = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$');
final _username = RegExp(r'^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$');
final _station = RegExp(r'^[A-Za-z0-9]{1,64}$');
final _track = RegExp(r'^(?:[0-9a-f]{64}|[A-Za-z0-9]{1,64})$');
final _t = RegExp(r'^[0-9]{1,5}$');

const Map<String, List<String>> _segs = {
  'artist': ['text'],
  'genre': ['text'],
  'station': ['station'],
  'track': ['track'],
  'map': ['slug', 'slug?'],
  'user': ['username'],
  'listens': [],
  'leaderboard': [],
};
const Map<String, List<String>> _fields = {
  'artist': ['name'],
  'genre': ['name'],
  'station': ['station'],
  'track': ['track'],
  'map': ['land', 'province'],
  'user': ['username'],
  'listens': [],
  'leaderboard': [],
};

class ListenUri {
  final String target;
  final Map<String, String> fields;
  final int t; // a track link's t=, or null
  String uri, web, https;

  ListenUri._(this.target, this.fields, this.t) {
    final path = StringBuffer(target);
    for (final f in _fields[target]) {
      if (fields.containsKey(f)) path..write('/')..write(encodeComponent(fields[f]));
    }
    if (t != null) path.write('?t=$t');
    uri = 'listen://$path';
    web = 'web+listen://$path';
    https = '$listenHttpsBase$path';
  }

  String operator [](String field) => fields[field];

  /// The parsed link, or null for anything the reference parser rejects.
  static ListenUri parse(Object input) {
    if (input is! String) return null;
    final String s = input;
    if (s.length > 1024) return null;
    String rest;
    final m = _scheme.firstMatch(s);
    if (m != null) {
      rest = m.group(2);
    } else if (s.toLowerCase().startsWith(listenHttpsBase)) {
      rest = s.substring(listenHttpsBase.length);
    } else {
      return null;
    }
    if (rest.contains('#')) return null;
    final q = rest.indexOf('?');
    var path = q >= 0 ? rest.substring(0, q) : rest;
    final query = q >= 0 ? rest.substring(q + 1) : '';
    if (path.endsWith('/')) path = path.substring(0, path.length - 1);
    final parts = path.split('/');
    final target = parts.removeAt(0).toLowerCase();
    final segs = _segs[target];
    if (segs == null) return null;
    final required = segs.where((r) => !r.endsWith('?')).length;
    if (parts.length < required || parts.length > segs.length) return null;
    final fields = <String, String>{};
    for (var i = 0; i < parts.length; i++) {
      final v = _decodeSeg(parts[i]);
      final ok = v == null ? null : _checkSeg(segs[i], v);
      if (ok == null) return null;
      fields[_fields[target][i]] = ok;
    }
    int t;
    if (query.isNotEmpty) {
      for (final pair in query.split('&')) {
        final kv = pair.split('=');
        final k = kv[0], v = kv.length > 1 ? kv[1] : '';
        if (!(target == 'track' && k == 't') || t != null) return null;
        if (!_t.hasMatch(v) || int.parse(v) > 86400) return null;
        t = int.parse(v);
      }
    }
    return ListenUri._(target, fields, t);
  }

  /// Builds a link; null when it would not parse back.
  static ListenUri build(String target, Map<String, String> fields, [int t]) {
    if (!_segs.containsKey(target)) return null;
    final l = ListenUri._(target, fields ?? <String, String>{}, t);
    return parse(l.uri) != null ? l : null;
  }

  /// The spacegho.st page for this link (path only), as the reference routeOf.
  String get route {
    switch (target) {
      case 'artist':
      case 'genre':
        return '/melodica/app/?seed=$target:${encodeComponent(this['name'])}';
      case 'station':
        return '/melodica/app/?station=${encodeComponent(this['station'])}';
      case 'track':
        return '/melodica/listens/?track=${encodeComponent(this['track'])}${t != null ? '&t=$t' : ''}';
      case 'map':
        return '/melodica/map/?land=${encodeComponent(this['land'])}${this['province'] != null ? '&province=${encodeComponent(this['province'])}' : ''}';
      case 'user':
        return '/melodica/leaderboard/?user=${encodeComponent(this['username'])}';
      case 'listens':
        return '/melodica/listens/';
      case 'leaderboard':
        return '/melodica/leaderboard/';
    }
    return '/melodica/';
  }
}

String _decodeSeg(String raw) {
  if (!_rawSeg.hasMatch(raw)) return null;
  final s = decodeComponent(raw);
  if (s == null || s.isEmpty || s.length > _maxText || s != _jsTrim(s)) return null;
  for (final c in s.codeUnits) {
    if (c <= 0x1f || c == 0x7f || c == 0x2f || c == 0x5c) return null;
  }
  if (s == '.' || s == '..') return null;
  return unorm.nfc(s);
}

String _checkSeg(String rule, String v) {
  switch (rule.replaceAll('?', '')) {
    case 'text':
      return v;
    case 'slug':
      return _slug.hasMatch(v) ? v : null;
    case 'username':
      return _username.hasMatch(v) ? v : null;
    case 'station':
      return _station.hasMatch(v) ? v : null;
    case 'track':
      return _track.hasMatch(v) ? v : null;
  }
  return null;
}

/// decodeURIComponent: %XX runs must be valid UTF-8; '+' stays '+'; null on error.
String decodeComponent(String s) {
  if (!s.contains('%')) return s;
  final out = StringBuffer();
  final bytes = <int>[];
  bool flush() {
    if (bytes.isEmpty) return true;
    try {
      // Dart's decoder drops a leading BOM (JS keeps it, then trim rejects it): decode after an 'A'.
      out.write(const Utf8Decoder(allowMalformed: false).convert([0x41, ...bytes]).substring(1));
    } catch (_) {
      return false;
    }
    bytes.clear();
    return true;
  }

  for (var i = 0; i < s.length;) {
    final c = s[i];
    if (c == '%') {
      if (i + 2 >= s.length) return null;
      final hi = _hex(s.codeUnitAt(i + 1)), lo = _hex(s.codeUnitAt(i + 2));
      if (hi < 0 || lo < 0) return null;
      bytes.add(hi * 16 + lo);
      i += 3;
    } else {
      if (!flush()) return null;
      out.write(c);
      i++;
    }
  }
  return flush() ? out.toString() : null;
}

int _hex(int c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/// encodeURIComponent.
String encodeComponent(String s) {
  const keep = "-_.!~*'()";
  const hex = '0123456789ABCDEF';
  final b = StringBuffer();
  for (final c in utf8.encode(s)) {
    final ok = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || keep.codeUnits.contains(c);
    if (ok) {
      b.writeCharCode(c);
    } else {
      b..write('%')..write(hex[c >> 4])..write(hex[c & 15]);
    }
  }
  return b.toString();
}

bool _jsSpace(int c) =>
    c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d || c == 0x20 || c == 0xa0 || c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;

/// String.prototype.trim: JavaScript's whitespace and line terminators.
String _jsTrim(String s) {
  var a = 0, z = s.length;
  while (a < z && _jsSpace(s.codeUnitAt(a))) a++;
  while (z > a && _jsSpace(s.codeUnitAt(z - 1))) z--;
  return s.substring(a, z);
}
