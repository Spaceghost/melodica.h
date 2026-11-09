// Incoming listen:// and https://spacegho.st/listen/ links, and what the app does with them.
// Links never start playback by themselves: the user confirms "Start <name> station?".
import 'dart:async';
import 'dart:io';

import 'package:epimetheus/audio/launch_helpers.dart';
import 'package:epimetheus/libepimetheus/stations.dart';
import 'package:epimetheus/listen/listen_uri.dart';
import 'package:epimetheus/listen/station_match.dart';
import 'package:epimetheus/models/collection/collection_model.dart';
import 'package:epimetheus/models/collection/static_collection_provider.dart';
import 'package:epimetheus/models/user/user.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:uni_links/uni_links.dart' as uni;
import 'package:url_launcher/url_launcher.dart';

class ListenLinks {
  ListenLinks._();
  static final ListenLinks instance = ListenLinks._();

  /// The newest link not handled yet (null when none).
  final ValueNotifier<String> pending = ValueNotifier<String>(null);

  // macOS: AppDelegate.swift keeps the links it gets from the system until Dart takes them.
  static const _mac = MethodChannel('epimetheus/listen_links');

  Future<void> init() async {
    if (kIsWeb) return;
    try {
      if (Platform.isAndroid || Platform.isIOS) {
        final first = await uni.getInitialLink();
        if (first != null) pending.value = first;
        uni.getLinksStream().listen((l) {
          if (l != null) pending.value = l;
        }, onError: (_) {});
      } else if (Platform.isMacOS) {
        _mac.setMethodCallHandler((call) async {
          if (call.method == 'changed') await _drainMac();
          return null;
        });
        await _drainMac();
      }
    } catch (_) {
      // no link support on this platform build
    }
  }

  Future<void> _drainMac() async {
    final links = await _mac.invokeListMethod<String>('takePending');
    if (links != null && links.isNotEmpty) pending.value = links.last;
  }

  /// Takes the pending link, if any.
  String take() {
    final l = pending.value;
    if (l != null) pending.value = null;
    return l;
  }
}

Future<void> _say(BuildContext context, String message) => showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(message),
        actions: <Widget>[FlatButton(child: const Text('OK'), onPressed: () => Navigator.pop(context))],
      ),
    );

Future<bool> _ask(BuildContext context, String question, String yes) async =>
    (await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(question),
        actions: <Widget>[
          FlatButton(child: const Text('Cancel'), onPressed: () => Navigator.pop(context, false)),
          FlatButton(child: Text(yes), onPressed: () => Navigator.pop(context, true)),
        ],
      ),
    )) ==
    true;

Future<void> _open(String url) async {
  if (await canLaunch(url)) await launch(url);
}

/// artist/genre: the matching station in the collection, started only after the user says so
/// (no match: offer the page on spacegho.st, which can create it). station/<id>: that station if
/// it is in the user's list. Everything else opens on spacegho.st in the browser.
Future<void> handleListenLink(BuildContext context, String link) async {
  final p = ListenUri.parse(link);
  if (p == null) return _say(context, "That link isn't supported.");
  if (p.target != 'artist' && p.target != 'genre' && p.target != 'station') return _open(listenSite + p.route);

  final user = UserModel.of(context).user;
  final provider = CollectionModel.of(context).getCollectionProvider<Station>() as StaticCollectionProvider<Station>;
  if (provider.downloaded == null) await provider.refresh(user);
  final stations = provider.downloaded;
  if (stations == null) return _say(context, 'Your stations could not be loaded, so the link was not opened.');

  final i = matchStation(p, [for (final s in stations) s.stationId], [for (final s in stations) s.title]);
  if (i < 0) {
    if (p.target == 'station') return _say(context, "That station isn't in your station list.");
    if (await _ask(context, 'There is no ${p['name']} station in your collection. Open it on spacegho.st?', 'Open')) {
      await _open(listenSite + p.route);
    }
    return;
  }
  if (await _ask(context, 'Start ${stations[i].title}?', 'Start')) {
    launchMusicProviderFromCollection<Station>(context, i);
  }
}
