Pithos
------

Pithos is a native Pandora Radio client for Linux. It's much more lightweight
than the Pandora.com web client, and integrates with desktop features such as media
keys, notifications, and the sound menu.

For screenshots, install instructions and more, see
[the Pithos home page](http://pithos.github.io).

### Scrobbling

Besides the Last.fm plugin, the ListenBrainz plugin (Preferences, Plugins) submits
now playing and listens to spacegho.st or any ListenBrainz-compatible server. Pick
the server, paste a token (for spacegho.st: https://spacegho.st/melodica/account/)
and press Check token. The token is kept in the keyring, the server URL in
GSettings (`io.github.Pithos.listenbrainz` `server-url`). A song counts once it is
longer than 30 seconds and has played for half its length or four minutes; listens
that cannot be sent wait in `~/.local/share/pithos/listenbrainz-queue.json` and are
retried every five minutes and after the next listen that goes through.

### listen:// links

The desktop entry registers `x-scheme-handler/listen`, and `pithos <link>` works too
(`listen://`, `web+listen://` or `https://spacegho.st/listen/`; see melodica-scrobble
docs/LISTEN-URI.md). Nothing plays until you say yes: artist and genre links ask
"Start <name> station?" and then play your station of that name or create one;
station links ask the same when the station is in your list. Every other target
opens on spacegho.st in the browser. Unsupported links show "That link isn't
supported". A link that arrives before sign-in waits until the stations load.

License: GNU GPLv3

Pithos is not affiliated with or endorsed by Pandora Media, Inc.
