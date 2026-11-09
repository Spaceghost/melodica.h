import 'package:epimetheus/scrobble/listenbrainz.dart';
import 'package:epimetheus/scrobble/scrobble_settings.dart';
import 'package:flutter/material.dart';

/// Settings > Scrobbling: a ListenBrainz-compatible server (spacegho.st by default) and a token.
class ScrobblePreferencesPage extends StatefulWidget {
  @override
  _ScrobblePreferencesPageState createState() => _ScrobblePreferencesPageState();
}

class _ScrobblePreferencesPageState extends State<ScrobblePreferencesPage> {
  static const _presets = <String, String>{
    spaceghostScrobbleBase: 'spacegho.st',
    listenBrainzBase: 'ListenBrainz',
    '': 'Other server',
  };

  final _serverController = TextEditingController();
  final _tokenController = TextEditingController();
  bool _loaded = false;
  bool _enabled = true;
  String _preset = spaceghostScrobbleBase;
  String _status = '';

  @override
  void initState() {
    super.initState();
    loadScrobbleConfig().then((c) {
      if (!mounted) return;
      setState(() {
        _enabled = c.enabled;
        _preset = _presets.containsKey(c.server) ? c.server : '';
        _serverController.text = c.server;
        _tokenController.text = c.token;
        _loaded = true;
      });
    });
  }

  @override
  void dispose() {
    _serverController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  String get _server => _preset.isNotEmpty ? _preset : _serverController.text.trim();

  Future<void> _save() async {
    await saveScrobbleConfig(ScrobbleConfig(enabled: _enabled, server: _server, token: _tokenController.text.trim()));
    if (mounted) setState(() => _status = 'Saved. It applies from the next station or playlist you start.');
  }

  Future<void> _check() async {
    setState(() => _status = 'Checking…');
    final valid = await ListenBrainzClient(_server, _tokenController.text, httpScrobbleTransport).validate();
    if (!mounted) return;
    setState(() => _status = valid == true ? 'The server accepts this token.' : valid == false ? 'The server refused this token.' : 'The server could not be reached.');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scrobbling')),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: <Widget>[
                SwitchListTile(
                  title: const Text('Scrobble listens'),
                  subtitle: const Text('Report what you play to a ListenBrainz-compatible server.'),
                  value: _enabled,
                  onChanged: (v) => setState(() => _enabled = v),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  decoration: const InputDecoration(labelText: 'Server'),
                  value: _preset,
                  items: [
                    for (final e in _presets.entries) DropdownMenuItem<String>(value: e.key, child: Text(e.value)),
                  ],
                  onChanged: (v) => setState(() => _preset = v),
                ),
                if (_preset.isEmpty)
                  TextField(
                    controller: _serverController,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(labelText: 'Server URL', helperText: 'The API base, e.g. https://example.org (the app adds /1/submit-listens)'),
                  ),
                const SizedBox(height: 8),
                TextField(
                  controller: _tokenController,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: const InputDecoration(labelText: 'Token', helperText: 'For spacegho.st, create one at spacegho.st/melodica/account/'),
                ),
                const SizedBox(height: 16),
                Row(
                  children: <Widget>[
                    RaisedButton(child: const Text('Save'), onPressed: _save),
                    const SizedBox(width: 12),
                    FlatButton(child: const Text('Check token'), onPressed: _check),
                  ],
                ),
                const SizedBox(height: 8),
                Text(_status),
              ],
            ),
    );
  }
}
