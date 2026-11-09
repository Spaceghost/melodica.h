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
