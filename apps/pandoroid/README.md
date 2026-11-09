Pandoroid Radio
===============

This is eventually going to be a full-featured [Pandora Radio](http://www.pandora.com/) client for Android-based devices.  Due to failings in the proprietary application provided by Pandora Radio themselves, this application is being designed with three focuses in mind: _stability_, _intuitiveness_, and _configurability_ (in that order). At this stage, those are more "goals" then an actual reality.

I work on this project in my spare time with [Bazaar](http://bazaar.canonical.com/) but push it to here for the added visibility.  Check out the project's home page (http://aregner.com/android/pandoroid/) for full details and its current status.

At the moment, the application is just about completely functional, with a few manageable bugs.  It is however not complete enough based on where I want to go with it nor properly tested.  Feedback is welcome and encouraged.

Scrobbling
----------

Settings > Scrobbling sends what you play to a ListenBrainz-compatible server: spacegho.st
(`https://spacegho.st/scrobble`, the default), ListenBrainz, or another server's API base. Paste
a user token (for spacegho.st, create one at https://spacegho.st/melodica/account/). The app
sends "playing now" when a song starts and a listen once the song has played for half its
length or 4 minutes (songs over 30 s only), with the album art URL, length and station name.
Listens that cannot be sent wait in the app's storage and go out on the next contact. The token
is never logged.

`tools/test-scrobble.sh` tests the plain-Java scrobbler (`src/org/melodica/scrobble/`) against
`tools/fake_lb.py`; CI runs it. The Android glue (preferences, service hooks) is checked by the
CI build only, not on a device.

listen:// links
---------------

Pandoroid opens `listen://` links and `https://spacegho.st/listen/` links (melodica-scrobble
docs/LISTEN-URI.md); Android offers it for both. A link never starts playback by itself:
- `artist/<name>` or `genre/<name>`: a station of that name (or "<name> Radio") from your list,
  after "Start <station>?". An artist with no station gets "Create and start a <name> station?"
  (Pandora's music.search and station.createStation). A genre with no station offers the page on
  spacegho.st instead.
- `station/<id>`: that station if it is in your list, after the same question.
- Anything else (track, map, user, listens, leaderboard) opens on spacegho.st in the browser.
- A link the parser rejects shows "That link isn't supported."

`src/org/melodica/listen/ListenUri.java` ports the reference parser; `tools/test-listen-uri.sh`
runs the reference's test cases (CI), and with `LISTEN_URI_REFERENCE` pointing at the reference
`listen-uri.js` also a 30000-link differential run against it. The release workflow's emulator
smoke opens three links against melodica-tuner (existing station, created station, cancel).
