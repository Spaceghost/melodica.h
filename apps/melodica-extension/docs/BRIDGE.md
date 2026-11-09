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
| page → ext | `{melodica:1, type:'command', id, action, …}`: `play` (`station: {token, name}` to start a station, none to resume), `pause`, `toggle`, `next`, `love`, `ban`, `tired`, `stop`, `volume` (`value` 0–100), `quality` (`value` high/medium/low), `stations` (reload the list), `openLogin` or `open-login` (opens the extension's sign-in: the toolbar popup where the browser allows it, else the popup page in a tab) |
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
refused after this browser's access answer said no. The web player's side of this is implemented in melodica-web by
its own maintainer; the extension's half is proven by the Chromium and Brave smokes
(`tests/smoke-extension.spec.mjs`, step "bridge remote").

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
