# Bridge protocol

The content script (`src/content.imba`) runs on `https://spacegho.st/melodica/*` (at `document_start`) and
talks to the page over `window.postMessage` (same window, same origin, every message has
`melodica: 1`). Two layers:

## 1. Relay (since 0.1.0)

The page sends its own Pandora calls through the extension instead of its relay.

| Direction | Message |
| --- | --- |
| ext → page | `{melodica:1, type:'present', name:'melodica-extension', version}` (since 0.8.2: once, as soon as the content script is injected, before the background has answered; "extension present, state pending") |
| page → ext | `{melodica:1, type:'hello'}` |
| ext → page | `{melodica:1, type:'ready', name:'melodica-extension', version, player: true, rooms: 1}` on engines with native Rooms (also sent unasked at `document_start`, `DOMContentLoaded` and `load`; `player: true` since 0.3.0 says layer 2 exists; `rooms: 1` says native room join/leave/control messages are supported) |
| page → ext | `{melodica:1, type:'request', id, search:'?method=…', body: Uint8Array}` |
| ext → page | `{melodica:1, type:'response', id, ok, status, body: Uint8Array, error}` |

Only `method`s matching `/^[a-z]+\.[A-Za-z]+$/` are forwarded; the background POSTs the body
to `<endpoint><search>` with `content-type: text/plain` and no cookies. A page that never
sends `subscribe` gets exactly this behaviour, unchanged.

The content script answers `hello` itself, without the background. Since 0.8.2 it also
wakes the background on load, which restores a remembered Pandora session and its
station list with no extension page open; no popup or player tab is needed after a
browser start or after the service worker was stopped.

Pages that need extension-owned Rooms support must wait for `ready.rooms === 1` before
sending `room-join`, `room-leave`, `room-command` or `room-audio-command`. Older extension
versions omit `rooms`; the page can then keep using its own room engine. This capability
flag keeps room handoff compatible with already-installed extensions during rollout.
Engines without the native RoomEngine host omit it. Room commands carry `roomId`
separately: the envelope `id` identifies the request and is never a room identifier.

## 2. Remote control (since 0.3.0)

The extension plays music itself, in the background, with no tab. A page that subscribes
becomes a view of that playback and a remote for it, instead of running its own loop.

| Direction | Message |
| --- | --- |
| page → ext | `{melodica:1, type:'subscribe'}`: start receiving state; answered at once with a `state` |
| page → ext | `{melodica:1, type:'unsubscribe'}` |
| ext → page | `{melodica:1, type:'state', state}` on subscribe and on every change (about once a second while playing) |
| page → ext | `{melodica:1, type:'command', id, action, …}`: `play` (`station: {token, name}` to start a station, none to resume), `resume` (since 0.8.4: the song in `last` from its saved position), `pause`, `toggle`, `next`, `love`, `ban`, `tired`, `stop`, `volume` (`value` 0–100), `quality` (`value` high/medium/low), `stations` (reload the list), `openLogin` or `open-login` (opens the extension's sign-in: the toolbar popup where the browser allows it, else the popup page in a tab), `play-seed` (since 0.8.5: `kind` `artist` or `genre`, `name`; also spelled `seed` with `seed: {kind, name}`; reuses a station named `<name>` or `<name> Radio`, else creates one from Pandora's best match of that kind, then an artist, then a song, and plays it; the result adds `station: {token, name}` and `created`; accepted from any https://spacegho.st/melodica/ page) |
| ext → page | `{melodica:1, type:'result', id, ok, error, state}` |

`state` is the background's `playerState`:

```json
{
  "status": "idle | loading | playing | paused | stopped | error",
  "station": {"token": "…", "name": "…"},
  "track": {"title": "…", "artist": "…", "album": "…", "coverArt": "…", "trackToken": "…", "rating": 0, "duration": 0, "quality": "high", "audioFormat": "aacplus"},
  "position": 12.3, "duration": 240, "volume": 80, "quality": "high",
  "queueLength": 3, "queue": [{"title": "…", "artist": "…", "album": "…", "coverArt": "…", "art": "…", "duration": 200, "trackToken": "…"}],
  "error": "", "history": [], "changedAt": 1794038444947,
  "stations": [{"token": "…", "name": "…", "isQuickMix": false, "allowDelete": true}],
  "loggedIn": true,
  "account": {"signedIn": false, "label": ""},
  "access": {"allowed": true, "message": ""},
  "scrobbling": {"on": true}
}
```

`queue` (since 0.8.6) is Up next: the songs left in the current playlist, in play order,
without slots or audio URLs (`art` is `coverArt` as Pandora gives it). It is pushed with
every state change, so it shrinks as songs start. `queueLength` still counts every item.

`last` (since 0.8.4) is the song this device's extension played last, or `null`:
`{title, artist, album, coverArt, trackToken, station: {token, name}, position, duration,
savedAt}`. It stays set while something plays (it is then the song playing, updated every 2 s) and after `stop`; it is cleared only by signing out. The extension saves it (sealed, in its own storage) every 2 s while playing and
on pause, stop and teardown, and keeps a copy of that song's audio while its own engine
plays it. After a browser restart, a stopped worker or a closed offscreen document, the
state shows that song paused at `position`; `resume` (or `play` with no station, or
`toggle`) plays it from there: from its link, else from the audio copy, else the station
goes on and `notice` says so. Only the device whose engine played a song keeps it; a page
acting as a remote never fetches or caches audio.

`scrobbling.on` (since 0.7.0) says whether the extension scrobbles to Spaceghost
Scrobbles. The side whose audio plays submits listens: while the page is a remote of
the extension, the extension is the only submitter and the page sends none.

`track.audioUrl` is omitted from all public state messages. While `track.ad` is true,
`next`, `love`, `ban` and `tired` do nothing. `subscribe` is answered whatever the extension is doing, including idle, signed out and right after browser start (the content script asks the background again for about 20 s before answering with an error), and a `state` is pushed on every change from any source (popup, player tab, keyboard shortcut, media keys, sign-in and sign-out). While no Pandora session exists, commands
fail with `ok: false` and the reason; `state.loggedIn` says so, and `state.access` carries
the access answer's message when access was not allowed (README "Access"). Relayed
Pandora calls (layer 1) other than `auth.partnerLogin` and `test.checkLicensing` are
refused after this browser's access answer said no. The web player's side of this is implemented in melodica-web by
its own maintainer; the extension's half is proven by the Chromium and Brave smokes
(`tests/smoke-extension.spec.mjs`, step "bridge remote").

### Same-device engine handoff

`command` additionally accepts `playback-export` and `playback-import`. Export
answers `{ok, playback, state}`. Its private `playback` is
`{v:1, sid, at, station:{id,name}, song, queue, position, duration, status,
quality, volume}`. The `song` and ordered `queue` include signed `audioUrl`s;
ordinary state/queue broadcasts continue to omit them. A web client keeps this
record in memory or its encrypted device vault, never localStorage.

Import sends `{action:'playback-import', playback}` after session exchange.
The extension checks the session id, freshness, bounded fields and media hosts,
then loads the supplied song and queue directly, without fetching a playlist.
The existing extension engine wins if it is already playing. A paused or
autoplay-blocked import does not overwrite the sealed last-play record until
this engine's audio actually plays.

Export additionally includes `played`: true only for a song this engine actually
heard, including a heard song currently paused or restored from its saved record.
Imported values cannot mark a song heard. An unheard paused import retains false
through engine recreation and never replaces the sealed last-play record.

A `session-offer` may include `playback` and `stations`. When the playback validates
against the offered session, the extension reuses those stations instead of
making a duplicate Pandora station-list request. A new session still requires
the normal access-service authorization. Offers without playback keep their
existing verification behavior. The browser handoff smoke tests both import and
session-offer against the tuner and checks that neither makes a Pandora call.

`playback-copy` mirrors the existing private audio copy to the same device's web
client before the extension is removed. Send `trackToken`, `offset` (default 0)
and `limit` (at most 262144 raw bytes). The direct result is
`{ok:true, copy:{sid,trackToken,offset,total,mime,bytes,done}}`, where `bytes` is
base64, or `copy:null` while the copy is unavailable. Only this session's current
or resumable song is eligible. The extension reads Cache Storage and never fetches
the media URL for this command. It reuses one Blob across chunks and releases it
at EOF, logout or after inactivity. The web client mirrors each track once,
validates contiguous chunks, and writes the resulting Blob into its own audio
cache. Heartbeats carry metadata and never repeatedly transfer the audio body.

The content script emits `{melodica:1,type:'gone',reason:'runtime-invalidated',
name,version}` when the browser invalidates the extension context (its runtime id
disappears, or a runtime API explicitly reports an invalidated context). Missing
replies and background suspension do not emit this signal. The web player must
keep its remote role during an uncertain timeout and reclaim audio only after
runtime invalidation. The Chromium lifecycle smoke disables the real extension
in the browser's extensions UI and verifies both the signal and closed offscreen
and background targets; stopping only the background emits no `gone`.

## 3. Session sharing (since 0.6.0)

The contract is melodica-web's `docs/BRIDGE.md` section 4 (agreed at 8a04339); this is
what the extension does.

- Messages go to the literal origin `https://spacegho.st` and are read only from it,
  on `/melodica/app/`. `ready` carries `session: 1`.
- `session-get` answers `{type: 'session', id, session, credential, account, revoked}`.
  `session` is the current Pandora session `{sid, email, partner, user, syncOffset,
  createdAt}`; `sid` is minted at each Pandora login (also the one after a 1001).
  `access` is the extension's current login-ok token (aud `melodica-extension`, which
  the relay accepts) or `null`; a new token is pushed with a new `session`. It is never
  taken from the page. `credential` is `{email, password}` only while "Remember me on this device" is on.
  `account` is `{signedIn, username, github}`; no OAuth token crosses. After the first
  `session-get` the page also gets an unsolicited `session` on every login, logout,
  credential or account change.
- `session-offer` with the page's session: `revoked` when its sid was signed out, `kept`
  when the extension already has a session (the extension's wins), `invalid` when the
  access check or Pandora refuses it (a credential that came with it is used only on
  1001), else `signed-in`: the extension takes the session, calls login-ok with it, and
  remembers the credential if one came.
- `session-logout {sid}`: the sid goes on `revokedSids` (storage.local, last 8); if it is
  the extension's session, the extension signs out (session, sealed login and key) and
  pushes `session: null`. Signing out in the extension does the same.
- When the page's `account.signedIn` is true and the extension is not signed in to
  spacegho.st, the extension tries one silent sign-in (`prompt=none`,
  `launchWebAuthFlow({interactive: false})`); `login_required` does nothing.
- The background accepts these only from this extension's content script in the top
  frame of a tab on `https://spacegho.st/melodica/app/` (`sender.id`, `frameId === 0`,
  `sender.tab`, `sender.url` origin and path, and `sender.origin` where the browser sets
  it); anything else gets `{ok: false, error: 'not allowed'}`.
- spacegho.st sign-out both ways: the page sends `{type: 'account-signout', id}` and the
  extension signs out of spacegho.st (revoking its refresh token) and answers `result`;
  when the extension signs out of spacegho.st itself it posts `{type: 'account-signout'}`
  (no `id`) to a page that has asked for the session, followed by a `session` whose
  `account.signedIn` is false.
  A sign-out made while no page has asked for the session sets `accountSignoutPending`
  (storage.local, no secrets); the next page gets `account-signout` right after the answer
  to its first `session-get`. Signing in to spacegho.st again clears it. `account-signout`
  from the page is answered `ok: true` whether or not the extension was signed in.
