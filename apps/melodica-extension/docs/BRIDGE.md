# Bridge protocol

The content script (`src/content.imba`) runs on `https://spacegho.st/melodica/app/*` and
talks to the page over `window.postMessage` (same window, same origin, every message has
`melodica: 1`). Two layers:

## 1. Relay (since 0.1.0)

The page sends its own Pandora calls through the extension instead of its relay.

| Direction | Message |
| --- | --- |
| page → ext | `{melodica:1, type:'hello'}` |
| ext → page | `{melodica:1, type:'ready', name:'melodica-extension', version, player: true}` (also sent once when the content script loads; `player: true` since 0.3.0 says layer 2 exists) |
| page → ext | `{melodica:1, type:'request', id, search:'?method=…', body: Uint8Array}` |
| ext → page | `{melodica:1, type:'response', id, ok, status, body: Uint8Array, error}` |

Only `method`s matching `/^[a-z]+\.[A-Za-z]+$/` are forwarded; the background POSTs the body
to `<endpoint><search>` with `content-type: text/plain` and no cookies. A page that never
sends `subscribe` gets exactly this behaviour, unchanged.

## 2. Remote control (since 0.3.0)

The extension plays music itself, in the background, with no tab. A page that subscribes
becomes a view of that playback and a remote for it, instead of running its own loop.

| Direction | Message |
| --- | --- |
| page → ext | `{melodica:1, type:'subscribe'}`: start receiving state; answered at once with a `state` |
| page → ext | `{melodica:1, type:'unsubscribe'}` |
| ext → page | `{melodica:1, type:'state', state}` on subscribe and on every change (about once a second while playing) |
| page → ext | `{melodica:1, type:'command', id, action, …}`: `play` (`station: {token, name}` to start a station, none to resume), `pause`, `toggle`, `next`, `love`, `ban`, `tired`, `stop`, `volume` (`value` 0–100), `quality` (`value` high/medium/low), `stations` (reload the list), `openLogin` (opens the extension's sign-in: the toolbar popup where the browser allows it, else the popup page in a tab) |
| ext → page | `{melodica:1, type:'result', id, ok, error, state}` |

`state` is the background's `playerState`:

```json
{
  "status": "idle | loading | playing | paused | stopped | error",
  "station": {"token": "…", "name": "…"},
  "track": {"title": "…", "artist": "…", "album": "…", "coverArt": "…", "trackToken": "…", "rating": 0, "duration": 0, "quality": "high", "audioFormat": "aacplus"},
  "position": 12.3, "duration": 240, "volume": 80, "quality": "high",
  "queueLength": 3, "error": "", "history": [], "changedAt": 1794038444947,
  "stations": [{"token": "…", "name": "…", "isQuickMix": false, "allowDelete": true}],
  "loggedIn": true,
  "account": {"signedIn": false, "label": ""},
  "access": {"allowed": true, "message": ""}
}
```

`track.audioUrl` is never sent to the page. While an ad plays, `track.ad` is true and
`next`, `love`, `ban` and `tired` do nothing. `subscribe` is answered whatever the extension is doing, including idle, signed out and right after browser start (the content script asks the background again for about 20 s before answering with an error), and a `state` is pushed on every change from any source (popup, player tab, keyboard shortcut, media keys, sign-in and sign-out). While no Pandora session exists, commands
fail with `ok: false` and the reason; `state.loggedIn` says so, and `state.access` carries
the access answer's message when access was not allowed (README "Access"). Relayed
Pandora calls (layer 1) other than `auth.partnerLogin` and `test.checkLicensing` are
refused while this browser's access answer is not "allowed". The web player's side of this is implemented in melodica-web by
its own maintainer; the extension's half is proven by the Chromium and Brave smokes
(`tests/smoke-extension.spec.mjs`, step "bridge remote").
