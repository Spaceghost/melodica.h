# melodica bridge: page ↔ extension

The contract between the web player at `https://spacegho.st/melodica/app/` (this repo,
`web/bridge.js`) and the melodica extension's content script (melodica-extension,
`src/content.imba`) and background. melodica-web owns this document; the extension's
`docs/BRIDGE.md` follows it. Status: section 4 v1 agreed with melodica-extension
(2026-11-08); the page side is implemented in melodica-web 0.8.0.

Agreed details: both sides use Pandora's android partner, and `syncOffset` is Pandora
seconds minus local seconds (int32) on both. The extension mints `sid` (24 base64url
chars) and `createdAt` at each Pandora login, including a re-login with the stored
credential after a 1001 (then it pushes `session`); a session restored from an offer
keeps the page's sid. The extension pushes nothing session-related before the page's
first `session-get`. A `session-logout` for a sid that is not the extension's current
one still goes on its revoked list and answers `ok: true`.

## 1. Transport and trust

- Same-window `window.postMessage`. Every message is an object with `melodica: 1` and a
  string `type`.
- **Sender:** always `window.postMessage(msg, 'https://spacegho.st')`: an explicit
  `targetOrigin`, never `'*'`. In tests the origin is the test server's, so both sides
  use `location.origin` only after checking it equals the expected origin (below).
- **Receiver (both sides):** drop the message unless all of these hold:
  `event.source === window`, `event.origin === 'https://spacegho.st'` (exact string
  compare, no `endsWith`), `location.pathname` starts with `/melodica/app/`, and
  `event.data.melodica === 1`.
- The content script runs only in the top frame (`all_frames: false`) of
  `https://spacegho.st/melodica/app/*`. The page sends `frame-ancestors 'none'`, so it is
  never framed.
- **Background (extension):** session messages (section 4) from `runtime.onMessage` are
  accepted only when `sender.id === runtime.id`, `sender.frameId === 0`, `sender.tab` is
  set, and `new URL(sender.url)` has origin `https://spacegho.st` and a path under
  `/melodica/app/` (Chrome: also `sender.origin === 'https://spacegho.st'`). Anything
  else gets `{ok: false, error: 'not allowed'}` and changes nothing.
- **Test builds** may widen the origin to one exact extra origin set at build time (the
  extension's e2e build and the page's test server). Production builds compare against
  the literal `https://spacegho.st`.

Threat model, stated plainly: the trust boundary is the origin `https://spacegho.st`. Any
script running in that origin (every spacegho.st page is first-party) and any other
extension allowed to read spacegho.st can already read the page, its storage and its
form fields, so the bridge does not try to hide secrets from them. The checks above keep
out other origins, other frames and other extensions' messages to the background.

## 2. Handshake

| Direction | Message |
| --- | --- |
| page → ext | `{type: 'hello'}`, every 250 ms for 3 s, again on demand |
| ext → page | `{type: 'ready', name: 'melodica-extension', version, player: true, session: 1}`; also unsolicited once when the content script loads |

`session: 1` says the extension speaks section 4 v1. Without it the page never sends
session messages.

## 3. Remote control (unchanged since extension 0.3.0)

| Direction | Message |
| --- | --- |
| page → ext | `{type: 'subscribe'}`, repeated every 1 s until the first `state`, then every 1 s while the tab is visible |
| page → ext | `{type: 'unsubscribe'}` |
| ext → page | `{type: 'state', state}` on subscribe and on every change |
| page → ext | `{type: 'command', id, action, …}`: `play` (`station: {token, name}`, or none to resume), `pause`, `resume`, `toggle`, `next`, `love`, `ban`, `tired`, `stop`, `volume` (`value` 0–100), `quality` (`value`), `stations`, `open-login` |
| ext → page | `{type: 'result', id, ok, error, state}`, then the same `state` pushed at once |

`state` as in the extension's docs/BRIDGE.md, plus (0.5.4+) `user: {username, chosen,
suggested, notice, prompt}`. While the extension is present (ready with `player: true`)
the page is only its remote: no local audio, no page login.

The page no longer uses the extension's relay layer (`request`/`response`); the
extension may keep it for older pages.

## 4. Session sharing (v1, new)

Goal: signed in on either side means signed in on both, with no prompt; signing out on
either side signs out both.

### 4.1 What is shared

```js
// "session": a Pandora session both sides can use (both use Pandora's android partner).
{
  sid: "<random id minted at the Pandora login that created this session, 16+ base64url chars>",
  email: "<the Pandora login, as typed, trimmed>",
  partner: {authToken: "…", id: 42},
  user: {authToken: "…", id: "<userId / listenerId>"},
  syncOffset: 123,          // integer seconds, Pandora time minus local time
  createdAt: 1794038444947  // ms, when Pandora accepted this login
}

// "credential": only while "remember" is on at the side that sends it.
{email: "…", password: "…"}

// "account": the spacegho.st identity (display only; no OAuth tokens cross over).
{signedIn: true, username: "night_owl", github: "octocat" | null}
```

OAuth tokens are bound to their client (`melodica-web` vs `melodica-extension`; refresh
tokens rotate per client), so they never cross the bridge. When one side is signed in to
spacegho.st and the other is not, the other signs itself in silently with
`prompt=none` (docs/ACCOUNT.md, Sign-in flow): the extension with
`identity.launchWebAuthFlow({interactive: false})`, the page with one top-level redirect
per browser session (guarded by a sessionStorage flag so it never loops). `login_required`
means no spacegho.st browser session: nothing happens, no prompt.

The melodica access tokens (relay `x-melodica-access`, aud `melodica`; login-ok `token`,
aud `melodica-extension`) are not shared either: each side gets its own (see 4.5).

### 4.2 Messages

| Direction | Message |
| --- | --- |
| page → ext | `{type: 'session-get', id}` |
| ext → page | `{type: 'session', id?, session, credential, account, revoked, access}`: answer to `session-get` (with its `id`), and unsolicited (no `id`) whenever the extension's Pandora session, remembered credential or account changes |
| page → ext | `{type: 'session-offer', id, session, credential?, account?}` |
| ext → page | `{type: 'result', id, ok, error, outcome}` with `outcome` one of `signed-in`, `kept` (the extension already has a session; it is unchanged), `revoked` (this `sid` was signed out; see 4.4), `invalid` (Pandora refused it and there was no usable credential) |
| page → ext | `{type: 'session-logout', id, sid}` |
| ext → page | `{type: 'result', id, ok, error}`; the extension then also sends an unsolicited `session` with `session: null` |
| page → ext | `{type: 'account-signout', id}`: the page signed out of spacegho.st (4.6) |
| ext → page | `{type: 'result', id, ok, error}` once the extension has signed out of spacegho.st too |
| ext → page | `{type: 'account-signout'}` (no `id`, no answer): the extension signed out of spacegho.st (4.6) |

`session` and `credential` are `null` when there is none. `access` (ext → page only) is
the extension's current login-ok token, or `null` (4.5); a new one is pushed in a new
`session` message. `revoked` is the list of the
last 8 `sid`s the extension signed out (4.4). The content script passes these through to
and from the background (`runtime.sendMessage({type: 'bridge-session-…'})`), which applies
the checks of section 1.

### 4.3 Flows

On every `ready` with `session: 1` the page sends `session-get` and then:

| Page | Extension | What happens |
| --- | --- | --- |
| signed in | signed out | Page sends `session-offer` (with its credential if "remember" is on). The extension restores the session (`Pandora.restore`), checks it with one cheap call (`user.getStationList` or `user.canSubscribe`); on Pandora 1001 it logs in with the credential if one came, else answers `invalid`. Then login-ok for its own token (4.5). It stores the session as if the user had signed in in the extension, the credential only if one came. The page becomes its remote. |
| signed out | signed in | The page stores the received session (and credential, if any) in its own encrypted store (section 5) with "remember" on, so it stays signed in after the extension is removed. It stays a remote while the extension is present. |
| signed in | signed in, same `sid` | Nothing to do. |
| signed in | signed in, other `sid` | The extension wins (it is the player): the page replaces its stored session with the extension's. |
| signed out | signed out | Login card in the extension (page shows "Sign in in the melodica extension"). |

While both are open, every change is pushed: the extension sends `session` after its
own login, logout or credential change; the page sends `session-offer` after its own
login (only possible while no extension is present, so in practice at the next `ready`).

### 4.4 Logout on either side logs out both

- **Extension logs out** (popup, options, account deletion, Pandora refusing the
  session): it forgets the session and the credential, adds the `sid` to `revoked`
  (kept in `storage.local`, last 8), and pushes `session` with `session: null`. A page
  that receives `session: null` whose stored `sid` is in `revoked`, or equal to the
  session it was mirroring, wipes its store (section 5) and shows the remote's
  signed-out view.
- **Page logs out** while the extension is present: it sends `session-logout` with its
  `sid`; the extension signs out (same as above) and confirms. The page wipes its store.
- **Page logs out while no extension is present**: the page adds the `sid` to its own
  revoked list (localStorage `melodica.revoked`, last 8 sids, no secrets). At the next
  `ready`, if the extension reports a session whose `sid` is in that list, the page
  sends `session-logout` for it instead of adopting it.
- **Offer of a revoked sid**: the extension answers `outcome: 'revoked'` and the page
  wipes its store instead of signing the extension back in.
- A spacegho.st sign-out on one side signs the other out of spacegho.st too (4.6). A
  Pandora logout does not sign out of spacegho.st, and the reverse.

### 4.6 spacegho.st sign-out on either side signs out both

- **Page signs out of spacegho.st** (its account menu or login card): it forgets its
  OAuth tokens, revokes its refresh token, and, with an extension present, sends
  `account-signout`. The extension forgets its OAuth tokens (`storage.local`
  `account`), revokes its refresh token, answers `ok: true` (also when it was not signed
  in), and pushes `session` with `account.signedIn: false`.
- **Extension signs out of spacegho.st** (popup, options): same locally, then posts
  `account-signout` to every page that has sent `session-get`. The page forgets its
  tokens, revokes its refresh token, and does not try the silent sign-in again in that
  browser session.
- **The other side was not there:** the side that signed out keeps a flag with no
  secrets (page: `localStorage` `melodica.account.signout`; extension: `storage.local`
  `accountSignoutPending`) and delivers `account-signout` at the next handshake: the
  page right after its `session-get` is answered, the extension right after it answers
  a page's first `session-get`. The page clears its flag on the `ok: true` result; the
  extension clears its flag once posted. Signing in to spacegho.st again on that side
  clears its flag first.
- The receiver of `account-signout` does nothing when it was not signed in to
  spacegho.st.
- `account` in `session` messages stays display only. A `signedIn: false` there no
  longer signs anything out; only `account-signout` does.

### 4.5 Access tokens after a shared session

- **Extension receiving the page's session:** it calls `/oauth/melodica/login-ok` with
  the received Pandora session (no password needed); that verifies the session with
  Pandora and returns the extension's own token, username and scrobble token.
- **Page receiving the extension's session:** the page needs the relay's
  `x-melodica-access` only when it plays on its own, i.e. after the extension is
  removed. Since spaceghost-auth 216b0a10 the relay also accepts the extension's
  login-ok token (aud `melodica-extension`, `pv: true`), so the page stores `access`
  with the session (encrypted, section 5) and sends it as `x-melodica-access` until its
  `exp` claim (read without verifying; the relay verifies). After that, or on a relay
  401, the page logs in again through the relay with the remembered credential when it
  has one, else shows the login card with the email filled in.

## 5. Page storage (melodica-web)

- One AES-GCM 256 key, generated with `extractable: false` and kept as a `CryptoKey` in
  IndexedDB (`melodica-vault` / store `keys` / key `vault`).
- One record in the same database (`vault` / key `vault`): `{v: 1, iv, ct}`; `ct` is
  the encryption of `{session, credential, relay: {token, exp}}`. Nothing else secret is
  stored; `localStorage` keeps only the email (to fill the form), settings and the
  revoked sids.
- Written only while "Remember me on this device" is on. Logout, unchecking it, or a
  revoked session deletes the record, the key and the in-memory session.
- On load: resume the stored Pandora session (and the relay token while it is valid);
  use the stored credential only when Pandora answers 1001 or the relay 401.
- A plaintext `melodica.password` left by older versions is moved into the vault on load
  and erased.

This protects the password from anything that reads the profile's files or
`localStorage` as text; it does not protect it from script running in the page's origin,
which can use the key.

## 6. Tests

- melodica-web `tests/bridge-unit.mjs`, `tests/remote.spec.mjs` (fake extension):
  origin checks, every flow in 4.3 and 4.4.
- melodica-web `tests/extension-real.spec.mjs` with the latest released extension
  against melodica-tuner: (a) sign in on the web, then load the extension: the extension
  is signed in and the page is its remote; (b) sign in in the extension, then open the
  page: the page is signed in, and after the extension is removed (a fresh context with
  the same page storage and no extension) it still plays (with "remember" on);
  (c) logout on either side signs out both.
- melodica-web storage test: after a remembered login, a dump of `localStorage` and
  IndexedDB does not contain the password string.
- melodica-extension: the background's sender checks, and the restore + check + login-ok
  path, in its own smokes.
