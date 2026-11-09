# Epimetheus Music Player
The Epimethus app - an open source Pandora client for Android, with other platforms coming soon™. 

### Features:
- Play existing stations from your Pandora account (browsing support planed for future releases)
- Rename and delete stations
- Set and manage station feedback

### Pandora features to be implemented in the future:
- Station creation
- On-demand song playback
- Downloads
- Podcasts (maybe)
- Pandora Premium/Plus checks. Most unfortunately, Pandora only block paid features in their free plan on the client side. This might remain unimplemented.

### Extra features to be implemented in the future:
- Proxy support to seamlessly access Pandora in unsupported countries

## Scrobbling

The drawer's **Scrobbling** page sends what you play to a ListenBrainz-compatible server:
spacegho.st (`https://spacegho.st/scrobble`, the default), ListenBrainz, or another server's API
base, with a user token (for spacegho.st, create one at https://spacegho.st/melodica/account/).
The token is kept in secure storage like the Pandora credentials and is never logged. "Playing
now" goes out when a song starts; a listen once it has actually played (seeking does not count)
for half its length or 4 minutes, songs over 30 s only, with the album art URL, length and
station name. Listens that cannot be sent are queued and retried. Settings apply from the next
station or playlist you start.

`tool/scrobble_test.sh` tests the plain-Dart scrobbler (`lib/scrobble/listenbrainz.dart`)
against `tool/fake_lb.py`; the release workflow runs it. The Flutter glue is checked by the CI
builds only, not on a device.
