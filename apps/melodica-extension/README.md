# melodica-extension

A Pandora WebExtension for Chrome, Brave and Firefox (Manifest V3). Before the Pandora
login it asks spacegho.st whether that email may use melodica (see "Access"
below); it is self-hosted and not on any store (`docs/STORES.md`). Two jobs:

- **A standalone player that needs no tab.** Sign in from the toolbar popup,
  pick a station, close the popup: the music plays in the background (an
  offscreen document in Chromium, the background page in Firefox; "Playback
  without a tab" below). The popup, the optional player tab (`player.html`)
  and the options page are views of that one state; media keys and two
  keyboard shortcuts steer it.
- **A bridge for the web client** at <https://spacegho.st/melodica/app/>.
  That page normally has to send every Pandora call through a Cloudflare
  Worker relay, because `tuner.pandora.com` sends no CORS headers; the relay
  sees every request, including the Blowfish-"encrypted" login whose key is
  public. With the extension installed the page can hand its requests to a
  content script instead, and they go to Pandora straight from the browser.

Everything the user runs is written in [Imba](https://imba.io) (the UI, the
background script, the content script), bundled to plain ES modules. The
protocol core (Blowfish with the public partner keys, hex, the `syncTime`
handshake and the JSON v5 request envelope) is freestanding
[Nelua](https://github.com/Spaceghost/nelua-lang) compiled to WebAssembly
with no imports at all. JSON and HTTP stay on the Imba side.

```
popup.html / player.html / options.html         bg.js (service worker / background page)      Pandora
  Imba tags (views) ── {type:'player', action} ─► playerState, the Pandora client (pandora.imba)
            ◄── {type:'player-state'} broadcast ──┤ core.envelope(json) ──► melodica_core.wasm (Nelua)
                                                  │ ◄── Blowfish-ECB hex ──┘
                                                  └─ fetch POST https://tuner.pandora.com/services/json/?method=… ──► 
                                                     ◄──────────────────────────── JSON unchanged ──────────────────
offscreen.html (Chromium) / the background page itself (Firefox)
  Engine (engine.imba): <audio src=audioUrl>, play loop, mediaSession ──────────────────────────► Pandora's CDN

https://spacegho.st/melodica/app/   content.js
  page ── postMessage {melodica:1,…} ──► bridge ── sendMessage ──► bg.js ── fetch ──► Pandora
```

Nothing is on the Chrome Web Store, Edge Add-ons or the AMO listings, and
nothing will be (`docs/STORES.md`, "Why not the stores"). The releases carry an
`.xpi` (signed by Mozilla on the unlisted channel, which lists nothing), a
`.crx` and unpacked-extension zips, and
<https://spacegho.st/melodica/extension/> (the self-hosted store,
repository Spaceghost/extensions-site) mirrors them with install buttons,
checksums, the CI proof and the update feeds.

## Access

Before `auth.userLogin` the background posts the email you log in to Pandora
with to `https://spacegho.st/oauth/melodica/access`
(`{"email", "client": "extension"}`, docs/ACCOUNT.md); spacegho.st decides
from it.

- Allowed: the login goes straight to Pandora as before.
- Not allowed: no login and no Pandora call; the card shows the server's
  message.
- The check is unreachable or answers something else: no login; the card says
  to try again.

The answer is kept in `storage.local` (`access`: email, allowed, time) and asked
again on every background boot and hourly while the extension is in use. If an
answer says no, playback stops, the Pandora session is dropped and the login
card shows the message; if a re-check cannot reach the server, the last answer
stands and it asks again in five minutes. The bridge (docs/BRIDGE.md) refuses
the web page's own Pandora calls past `auth.partnerLogin` only after an
answer that said no.

## The spacegho.st account (optional)

**Sign in with spacegho.st** (popup, player tab and options page) links this
browser to a spacegho.st account; melodica works without it. It is OAuth 2.1
with PKCE (client `melodica-extension`): `browser.identity.launchWebAuthFlow`
opens `https://spacegho.st/oauth/authorize`, the redirect comes back to
`identity.getRedirectURL('oauth')` (`https://<extension id>.chromiumapp.org/oauth`
in Chromium, `https://<uuid>.extensions.allizom.org/oauth` in Firefox, where the
uuid derives from `browser_specific_settings.gecko.id`, which must therefore
never change), and the code is exchanged at `/oauth/token`. The tokens live in
`storage.local` (`account`); the refresh token rotates on every refresh, and
sign-out revokes it. While signed in, the access token goes as the bearer to
`/oauth/melodica/access` and `/oauth/melodica/policy`, which are asked at boot and
hourly. The account line shows the account's display name, or "Signed in".

Usernames (docs/ACCOUNT.md, Usernames): right after Pandora accepts the login, the
background posts the Pandora session to `/oauth/melodica/login-ok`, which checks it
with Pandora and returns a verified melodica token (kept in session storage) and the
username. The popup and player tab show the username where they said "Signed in";
while it is a generated `listener-…` name, a "Pick a username" card offers to change
it (prefilled with the GitHub login when one is suggested; "Not now" hides it until
the next login), and the options page has a "Change username" field. The server's
answers (taken, not allowed, locked, rate limited) show under the field. `/me` and
`/username` take the spacegho.st account's token when signed in, else the melodica
token. No email is shown or kept for this.
`src/account.imba` holds the PKCE, redirect, token and policy parsing
(`tests/account.test.mjs`); `src/bg.imba` holds the flows. On Safari the sign-in
opens in a tab (client `melodica-ios`, redirect `https://spacegho.st/melodica/app/`)
and a content script there hands the address back.

Needs: the `identity` permission and the host permission
`https://spacegho.st/oauth/*` (the endpoints also answer CORS, so Firefox,
which grants host permissions on request, works without it).

For tests: the storage key `accountBase` (default `https://spacegho.st`) points
access and the account at another server; the Firefox smoke sets it to a local
server because Firefox has no host-resolver flag, and the options page shows
the override. The Chromium and Brave smokes keep the default and resolve
`spacegho.st` to their local server. Both use `tests/fake-account.mjs`, a
stand-in built to docs/ACCOUNT.md. **The real spacegho.st, a real GitHub
sign-in and launchWebAuthFlow's own window are not exercised in CI.**

## Install

Buttons and current steps: <https://spacegho.st/melodica/extension/>.

- **Firefox:** `melodica-extension-<ver>.xpi`, served there as
  `application/x-xpinstall` so Firefox offers its install prompt. Since v0.1.4
  the file is **signed by Mozilla** (CI runs `web-ext sign --channel unlisted`
  with the repository's AMO credentials; the release notes say "Signed by
  Mozilla" and the file carries `META-INF/mozilla.rsa`), so release Firefox
  128+ installs it. If signing ever fails for a version, that release's `.xpi`
  is unsigned and the notes and `docs/STORES.md` give the fallback routes.
  gecko id `melodica-extension@spacegho.st`; update feed
  `https://spacegho.st/extensions/dl/melodica-extension/updates.json`.
- **No store listings:** `docs/STORES.md` says why (access is decided by
  spacegho.st per login, which no store can express, and we will not ship a store build that behaves
  differently from this one).
- **Chrome / Edge / Brave:** `melodica-extension-<ver>.crx` is a CRX3 signed
  with the repository's key (secret `CRX_PRIVATE_KEY`; the public half gives
  the Chrome extension id **`obbahflgghfemmpmjppeibnemibgblbd`**, computed by
  `scripts/crx-id.mjs`). Linux: `chrome://extensions` (`brave://extensions`,
  `edge://extensions`) → Developer mode → drag the file onto the page. Windows
  and macOS block off-store `.crx` installs except by enterprise policy
  (`ExtensionInstallSources` + `ExtensionInstallForcelist` with the update
  feed `https://spacegho.st/extensions/dl/melodica-extension/update.xml`,
  which is also the manifest's `update_url`; Brave honours the same Chromium
  policies); otherwise load the zip unpacked. Brave uses the Chrome build
  unchanged, and CI runs the full smoke in it (below).

### iPhone and iPad

`melodica-<ver>-unsigned.ipa` on the release (and on the store page, as
"iPhone / iPad (sideload)") is a small app that carries the extension for
Safari. It asks spacegho.st about access like every build ("Access" above). It is not on the App Store or TestFlight and
never will be submitted to either; there is no public link of any kind.
Build, manifest and playback details: `ios/README.md`.

**Free route: SideStore or AltStore with your own Apple ID.**

1. Set up [SideStore](https://sidestore.io) or [AltStore](https://altstore.io)
   on the iPhone or iPad with your own Apple ID (a free one works).
2. Download `melodica-<ver>-unsigned.ipa` on the device and open it in
   SideStore/AltStore (My Apps → +). It signs the app with your Apple ID.
3. A free Apple ID's signature lasts **7 days**: SideStore/AltStore refresh it
   (in the background when they can, or tap Refresh). If it lapses the app and
   the extension stop opening until you refresh; your settings stay. A free
   Apple ID allows 3 sideloaded apps at a time, and this one counts the app and
   its extension against the weekly App ID limit.
4. Settings → Apps → Safari → Extensions → **melodica** → turn it on (older
   iOS: Settings → Safari → Extensions).
5. On the same screen, allow it on `tuner.pandora.com` (and the other
   `pandora.com` hosts) and `spacegho.st`, or answer "Allow" when Safari asks.
6. In Safari, the extensions menu (puzzle piece in the address bar) →
   melodica opens the popup. Sign in to Pandora (the access check runs first);
   starting a station opens the
   player in a Safari tab, which is where the music plays.

**Paid route (not set up): ad hoc or internal TestFlight on Jack's Apple
Developer account ($99/year).** Ad hoc: up to 100 registered devices per year,
installed from a signed `-adhoc.ipa` with no sideloading app and no 7-day
refresh; CI already has the inactive hook for it (`ios/README.md`, "Signing
hook"). Internal TestFlight: up to 100 named testers who are members of the
developer team, no App Review, no public listing or link. Either one needs
Jack's account; neither is configured.

**What is proven:** CI builds the app for devices and for the simulator,
installs and launches it in the iOS Simulator, checks that the system
registered the extension, switches it on in Safari and opens
spacegho.st/melodica/app/, whose status line then reads "direct via
melodica-extension <version>": the extension's content script ran in iOS
Safari (`smoke-ios.json`, `smoke-ios-bridge.png`). Not proven: any install on a
real iPhone or iPad, the popup, the player and the Pandora login on iOS, the
Safari spacegho.st sign-in, and playback with Safari in the background or the
screen locked (`ios/README.md`).

### Install (unpacked)

Download `melodica-extension-<ver>-chrome.zip` or `-firefox.zip` from the
[latest release](https://github.com/Spaceghost/melodica-extension/releases)
and unzip it.

- **Chrome / Chromium / Edge:** `chrome://extensions` → Developer mode → Load
  unpacked → the unzipped folder.
- **Brave:** `brave://extensions` → Developer mode (top right) → Load unpacked
  → the unzipped folder (the Chrome zip). Shields stay as they are: the
  extension's requests are its own, not a web page's, so Shields' per-site
  settings do not apply to them.
- **Firefox (128+):** `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → pick `manifest.json` in the unzipped folder (it is removed when
  Firefox quits), or `npx web-ext run --source-dir <folder>`. A permanent
  install is the signed `.xpi` above.

The `-chrome` and `-firefox` zips are the same build; the Firefox one keeps
`browser_specific_settings.gecko` (id `melodica-extension@spacegho.st`,
`update_url` to the store's `updates.json`) and `background.scripts`, the
Chrome one drops them so Chrome does not warn and carries the top-level
`update_url` to the store's `update.xml` (ignored for an unpacked load, which
is how the CI smoke runs).

## Layout

| Path | What |
| --- | --- |
| `core/melodica_core.nelua` | the wasm core (freestanding Nelua); `core/pi_hex.nelua` is Blowfish's pi table copied from melodica.h |
| `core/test.mjs`, `core/ref-blowfish.mjs` | Node unit test: libpiano's vector from melodica.h `tests/crypt.c`, an independent JS Blowfish for cross-checks, hex, syncTime, the envelope, the arena |
| `src/core.imba` | JS wrapper around the wasm exports |
| `src/pandora.imba` | JSON API v5 client: partnerLogin, userLogin, station list, playlist, feedback, sleep, explain, search, create/delete station; one re-login on code 1001; errors name the call and code ("Pandora rejected auth.userLogin (code 1002: invalid login). Wrong email address or password."); the client User-Agent (below) |
| `src/bg.imba` | background: the access check (before the login, at boot, hourly; refusals), the optional spacegho.st account (sign-in, refresh, policy), playlist slots (`ad.getAdMetadata`, `ad.registerAd`), session (in `storage.session`), every Pandora request, the player state (`playerState`, persisted in `storage.session`, broadcast on every change), the player commands, the badge, the keyboard shortcuts, the offscreen document (Chromium) or the in-page engine (Firefox), the bridge relay, the diagnostics log (last 200 lines in `storage.session`, no tokens) |
| `src/engine.imba` | the playback engine: the `<audio>` element, playlist queue, track advance, ratings, volume, the play log, `navigator.mediaSession`; talks to Pandora only through the background |
| `src/offscreen.imba`, `public/offscreen.html` | Chromium's home for the engine: the offscreen document (`chrome.offscreen`, reason `AUDIO_PLAYBACK`) |
| `src/update.imba`, `tests/update.test.mjs` | update awareness: version compare, the store feeds, the "is available" banner state, and its Node unit test |
| `src/account.imba`, `tests/account.test.mjs` | the spacegho.st account's PKCE, authorize URL, redirect, token and policy parsing, and its Node unit test |
| `tests/fake-account.mjs` | the smokes' stand-in for spacegho.st's access check and OAuth endpoints (docs/ACCOUNT.md); `SPACEGHOST_AUTH_ADAPTER` swaps in another implementation |
| `src/popup.imba`, `src/player.imba`, `src/options.imba`, `src/ui.imba`, `src/shared.imba` | the pages (views of the background's state) and shared tags |
| `src/content.imba`, `docs/BRIDGE.md` | the bridge content script for `https://spacegho.st/melodica/*`: the request relay and the playback remote control |
| `public/` | `manifest.json` (one template, two outputs), the HTML pages (no inline scripts), `theme.css`: part 1 is melodica-web's `web/app.css` copied unchanged (the phone layout: one centered column of cream cards, ink in dark mode), part 2 the extension's additions (popup width 380 px, the inline station list, the update banner, the options form) |
| `scripts/build-core.sh` | Nelua → C (`--target wasm32-unknown-unknown`) → `clang -nostdlib` → audits exports/imports |
| `scripts/build.mjs` | esbuild + `imba/compiler` → `dist/chrome`, `dist/firefox`, `build/node/{core,pandora,account,update}.js`; generated icons; CSP guards |
| `scripts/real-pandora-probe.mjs` | no-account probe of the client + wasm core against the real `tuner.pandora.com` from Node: partnerLogin, syncTime, userLogin with bogus credentials, expects code 1002 (below) |
| `scripts/package.sh` | the zips (`-chrome`, `-firefox`), the `.xpi`, the `.crx` (via `crx3`, key from `$CRX_KEY`), the source tarball, `SHA256SUMS` |
| `docs/STORES.md` | why there are no store listings; the Mozilla signature (unlisted channel) and the Firefox fallback routes |
| `scripts/crx-id.mjs` | the Chrome extension id of a key: first 128 bits of SHA-256 over the DER SubjectPublicKeyInfo, hex mapped to a–p |
| `tests/smoke-extension.spec.mjs` | the Playwright proof (below) in Playwright's Chromium or, with `MELODICA_BROWSER=brave`, an installed Brave; `tests/fixtures/melodica-web-dist` is melodica-web 0.2.0's built page |
| `tests/smoke-firefox.mjs` | the Firefox proof (below): Mozilla Firefox through geckodriver + selenium-webdriver, `dist/firefox` as a temporary add-on, the tuner, then the real Pandora with bogus credentials |
| `.github/workflows/ci.yml` | build (+ unit tests, AMO signing on tags) → `smoke` (Chromium), `smoke-brave` (Brave stable from Brave's apt repository) and `smoke-firefox` (Mozilla Firefox from packages.mozilla.org, plus the real-Pandora probe) → release on `v*` tags; no store jobs |

### Core (wasm) exports

C ABI, all `mx_*`, no imports. Sizes are `usize` (32-bit here). The sized
functions follow melodica.h's convention: they return the size required and
write only when the capacity suffices, 0 on a rejected input.

| export | |
| --- | --- |
| `mx_abi() -> 1`, `mx_version() -> ptr`, `mx_version_len()` | |
| `mx_alloc(n) -> ptr`, `mx_free(ptr)`, `mx_reset()`, `mx_arena_capacity()`, `mx_arena_used()` | a 256 KiB static arena; frees nest (LIFO) |
| `mx_init() -> bool` | key setup for the `android` partner (encrypt `6#26FRL$ZWD`, decrypt `R=U!LH$O2B#`) |
| `mx_init_keys(enc, enc_len, dec, dec_len) -> bool` | any partner pair |
| `mx_encrypt(src, len, dst, cap)` | Blowfish-ECB, NUL padding to 8, lowercase hex |
| `mx_decrypt_hex(src, len, dst, cap)` | hex → plaintext (padding kept) with the decrypt key |
| `mx_hex_encode`, `mx_hex_decode` | strict hex |
| `mx_sync_parse(hex, len, now) -> server seconds` | decrypts `syncTime`, skips 4 junk bytes, reads the digits (libpiano's `strtoul(+4)`), records `server - now` |
| `mx_sync_offset()`, `mx_set_sync_offset(o)`, `mx_sync_time(now)` | the clock offset |
| `mx_envelope(json, len, now, dst, cap)` | appends `"syncTime":<server time>` to a JSON object and encrypts it: the body of every call after `auth.partnerLogin` |

The partner credentials (`android` / `AC7IBG09A3DTSYM4R41UJWL07VLN8JI7` /
`android-generic`) are the ones pianobar ships in `settings.c`; they are
public and identify the client type, not the user.

## Build

Nothing is compiled on the workstation; the builds below ran in an Incus
container on bak (`melodica-ext`, Ubuntu 24.04, Node 22, clang/lld 18, Jack's
Nelua fork copied to `/opt/nelua`) and on GitHub Actions.

```sh
npm install
NELUA=/opt/nelua/nelua scripts/build-core.sh      # build/core/melodica_core.wasm (+ export/import audit)
node scripts/build.mjs --version 0.1.0            # dist/chrome, dist/firefox, build/node/{core,pandora,account,update}.js
node core/test.mjs                                # 30 checks
node tests/account.test.mjs                       # the account's PKCE, redirect, token and policy parsing
npx web-ext lint --source-dir dist/firefox --self-hosted
CRX_KEY=/path/to/key.pem scripts/package.sh 0.1.0 # release/*-{chrome,firefox}.zip, .xpi, .crx, -src.tar.gz, SHA256SUMS (no .crx without CRX_KEY)
```

`scripts/remote-sync.sh '<command>'` copies the tree into the container and
runs the command there.

Imba is compiled with `imba/compiler` from an esbuild plugin rather than
`imba build`, because the extension needs stable, unhashed file names
(`bg.js`, `popup.js`, …) that the manifest can reference. Imba's scoped CSS is
registered at runtime by its own runtime (a `<style>` element); MV3's default
CSP does not restrict styles. The pages have no inline scripts; the bundles
contain no `eval`/`new Function`; our sources never touch `innerHTML` (the
Imba runtime keeps an `innerHTML` path for `<template>` content and SSR
hydration that nothing here calls, which `web-ext lint` reports as warnings,
not errors).

## Manifest

- `background`: `{"service_worker": "bg.js", "scripts": ["bg.js"], "type": "module"}` (MDN's cross-browser pattern; Chrome 121+ accepts both keys, Firefox uses `scripts`).
- `host_permissions`: `https://tuner.pandora.com/*`, `https://*.pandora.com/*`, `https://spacegho.st/oauth/*` (the access check and the optional account), `https://spacegho.st/extensions/*` (the update feed). `optional_host_permissions`: `https://*/*`, `http://*/*` for an endpoint override (the options page offers a "Grant access" button; without it the endpoint must allow CORS, which melodica-tuner does).
- `permissions`: `storage`, `identity` (the optional spacegho.st sign-in's `launchWebAuthFlow` / `getRedirectURL`); the Chromium build adds `offscreen` (the playback document).
- `commands`: `toggle-play` (Alt+Shift+P) and `next-song` (Alt+Shift+N), handled in the background.
- The Firefox build has no `service_worker` key and sets `background.persistent: true` (see "Playback without a tab").
- `content_scripts`: `content.js` on `https://spacegho.st/melodica/*`, at `document_start`.
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (the wasm needs `'wasm-unsafe-eval'`).
- `browser_specific_settings.gecko.id`: `melodica-extension@spacegho.st`, `strict_min_version` 128.
- The `browser` namespace is used everywhere with `globalThis.browser = globalThis.chrome` as the only polyfill (promise-returning APIs in MV3 Chrome; `onMessage` listeners answer through `sendResponse`).

## Playback without a tab

The extension plays the music itself; no tab has to be open. The background
(`src/bg.imba`) owns one `playerState` (`status`, `station`, `track`,
`position`, `duration`, `volume`, `quality`, `queueLength`, `error`,
`history`), keeps a copy in `storage.session`, broadcasts
`{type:'player-state'}` on every change, and answers `player-get` and
`{type:'player', action}` with `play` (a station token, or none to resume),
`pause`, `toggle`, `next`, `love`, `ban`, `tired`, `sleep`, `stop`, `volume`,
`quality`. The popup, the player tab, the options page and a subscribed web
page (`docs/BRIDGE.md`) are views that send those commands; none of them
holds an `<audio>` element. The player tab is optional: opening it starts
nothing and closing it stops nothing. The toolbar badge shows `▶` or `❚❚`
and its tooltip the track.

Where the audio runs (`src/engine.imba`, the same class in both places):

- **Chromium (Chrome, Brave, Edge):** an offscreen document
  (`offscreen.html`, `chrome.offscreen.createDocument` with reason
  `AUDIO_PLAYBACK`, permission `offscreen`), created on the first command and
  checked with `runtime.getContexts` before every creation. Chrome may close
  the document about 30 s after audio stops; the next command recreates it and
  the `engine-hello` handshake hands it the saved state (station, volume,
  quality, play log, a paused track at its position). Pandora calls from the
  engine go through the background (`playlist`, `rate`, `tired` messages),
  since an offscreen document has only runtime messaging.
- **Firefox:** no offscreen API, so the engine runs in the background page
  itself (the `scripts` background has a DOM). The gecko manifest sets
  `background.persistent: true`; Firefox MV3 warns that the key is
  unsupported and treats the background as an event page, which it may
  terminate after 30 s of no extension activity. Whether playing audio
  counts as activity is what the Firefox smoke measures: 45 s with no
  extension page open, then the state must still be `playing` with the
  position advanced (`audio.noPage` in `smoke-firefox.json`). If a Firefox
  build ever fails that check, the fallback is a Manifest V2 build for Firefox
  with a real persistent background page; it is not implemented.

Media keys: the engine registers `navigator.mediaSession` handlers (play,
pause, next) and metadata (title, artist, album, cover) where it runs, so the
keyboard and the OS media controls work while no page is open. The manifest's
`commands` add Alt+Shift+P (play/pause) and Alt+Shift+N (next).

Resume (since 0.8.4): the engine saves the song it plays (station, track, link,
position, the next few queued songs) every 2 s and on pause, stop and teardown,
sealed with its own AES-GCM key into `storage.local` (`lastPlay`), and keeps a copy
of that song's audio in Cache Storage (`melodica-audio`, the song playing only; a
finished song's copy is deleted; quota and network errors just leave no copy). After
a browser restart, a stopped worker or a closed offscreen document, the popup, the
player tab and the bridge show that song paused at its position; Resume plays it from
there: from its link, else from the copy, else the station goes on and says so.
Signing out of Pandora deletes the record and the copy. Pages that are remotes never
fetch or keep audio. Proven in Chromium and Brave against melodica-tuner (whose songs
are about 10 s, so a few seconds in, not minutes): after the offscreen document and
the worker went away, after a browser restart, and with the link made unusable
(audio copy, then the station; and with no copy, the station). Not run in Firefox or
Safari, and not against real Pandora audio hosts: a copy needs the audio host to be
inside the extension's host permissions (`*.pandora.com`).

## Updates

What updates by itself: **Firefox** reads `gecko.update_url`
(`https://spacegho.st/extensions/dl/melodica-extension/updates.json`) on its
own schedule (daily) and installs the signed `.xpi` it names; **Chrome, Brave
and Edge** do the same from the manifest's `update_url`
(`…/dl/melodica-extension/update.xml`) for a `.crx` or enterprise-policy
install. An **unpacked zip** (Load unpacked) has no update path in any
browser; it only gets the banner below.

What the extension adds (`src/update.imba`, `src/bg.imba`): on every
background boot and at most every six hours while a page is open, Chromium
is asked to run its own update check (`runtime.requestUpdateCheck`; a no-op
for an unpacked load), and the store feed is read (`releases.json` in the
Chromium build, `updates.json` in the Firefox build; host permission
`https://spacegho.st/extensions/*`, and the feeds also allow CORS). When the
store serves a newer version than `runtime.getManifest().version`, the popup,
player and options page show "melodica `<v>` is available" with a link to
<https://spacegho.st/melodica/extension/>. On Chromium, once the
browser has fetched an update (`runtime.onUpdateAvailable`) the background
calls `runtime.reload()` immediately if nothing is playing, otherwise when
playback stops, and the banner offers "Reload to update" meanwhile. Firefox
installs updates itself; the extension does nothing extra there. The options
page has "Check for updates" and shows what the store serves.
`tests/update.test.mjs` covers the version compare, both feed shapes and the
banner state; the Chromium and Brave smokes serve a `releases.json` naming
99.0.0 from their local spacegho.st and assert the banner (the Firefox smoke
reads the real feed, so it shows none).

## Options

- **API endpoint** (default `https://tuner.pandora.com/services/json/`): where
  `POST ?method=…` goes. CI points it at melodica-tuner. Changing it drops the
  session.
- **spacegho.st account**: optional; Sign in / Sign out, and the server it
  asks (the override is shown when the `accountBase` storage key is set).
- **Audio quality**: high / medium / low, picked from Pandora's `audioUrlMap`
  (falls back to the next available).
- **Remember me on this device**: the Pandora session and login are sealed with
  AES-GCM under a non-extractable key generated once and kept in the extension's
  own IndexedDB (`src/vault.imba`); `storage.local` holds only the ciphertext and
  iv (`vault`), never the password, and nothing goes to `storage.sync`. At start-up
  the sealed session is resumed; the password is used only when Pandora answers
  1001 (session expired). Signing out or unticking it deletes the sealed record,
  the key and the session. A plaintext password left by versions before 0.6.0 is
  sealed at start-up and erased. Where IndexedDB or WebCrypto is missing, nothing
  is remembered.
- **Scrobbling** (on by default): while you are signed in to Pandora, what you
  play is scrobbled to Spaceghost Scrobbles (spacegho.st/melodica/listens/) under your
  melodica account. A `playing_now` goes out when a song starts and one listen
  once it has played half its length or 4 minutes, whichever comes first; songs
  of 30 s or less are never sent. A listen carries the artist, title,
  album, length, cover URL and `submission_client: melodica-extension`, nothing
  else. Listens that cannot be sent (offline, server errors) wait in
  `storage.local` (`scrobbleQueue`, at most 50) and go out later. Nothing is sent
  until the first-run notice ("Scrobbling to spacegho.st is on. Turn it off in
  settings.") has been seen. The switch here is the account's own setting
  (`/scrobble/api/me/settings`), so turning it off on the scrobble site turns it
  off here too. With the web app open as a remote, only the extension submits
  (docs/BRIDGE.md).
- **Listens, Leaderboard, Map** (the player tab) and **Recent listens** (the popup):
  the shared Scrobbles UI from Spaceghost/melodica-scrobble `ui/dist/`
  (docs/CLIENTS.md there) at the commit in
  commit and sha256 in `scrobble-ui.pin`, fetched at build time into the gitignored `vendor/scrobble-ui/` by `scripts/fetch-scrobble-ui.sh`, and shipped inside the
  extension; no remote code runs. It talks to `spacegho.st/scrobble/api/` (host
  permission `https://spacegho.st/scrobble/*`) and its live channel with the melodica
  token. The Map tab shows only when Scrobbles says the account is signed in with
  GitHub (`crew_viewer`). Links go to the pages under spacegho.st/melodica/.
- **Check for updates**: reads the store feed now (above).
- **Copy diagnostics**: the last 50 lines of the background log (boot,
  permissions, each request's method, size, syncTime, clock offset and which
  User-Agent it carried, each answer's HTTP status and Pandora code) plus the
  browser's UA, the endpoint and the granted permissions, with tokens and
  passwords reduced to their lengths; copied to the clipboard when the page is
  allowed to, and always shown in a box to copy from.

## The request User-Agent (why 0.1.4 said "Your session expired")

Versions up to 0.1.4 sent every request with the browser's own `User-Agent`
(an extension's `fetch` does, unless it sets one). `tuner.pandora.com` treats
a request whose User-Agent is a browser's differently: `auth.userLogin` then
takes ten seconds and comes back as **code 1001** with the message "Invalid
username and/or password", which the client mapped to "Your session
expired." The same request with any non-browser User-Agent (Node's, pianobar's
`pianobar-<version>`, ours, even an empty one) is answered at once with
code 1002 for bogus credentials. This was found on 2026-11-07 by driving
`src/pandora.imba` + the wasm core from Node against the real Pandora with the
headers varied one at a time (`Origin`, `Sec-Fetch-*`, `Accept-Language` made
no difference; `User-Agent: Mozilla/5.0 … Firefox/159.0` and Chrome's UA each
flipped the answer to 1001), and then reproduced in a real Firefox with the
extension installed (`tests/smoke-firefox.mjs`, before the fix: 1001; after:
1002). The envelope, syncTime (4 junk bytes, 10 ASCII digits, padding) and
`auth_token`/`partner_id` query were byte-identical to melodica.h's C
reference in both cases, so none of them was the cause.

Since 0.1.7 the client sends `User-Agent: melodica-extension/<version>
(+https://github.com/Spaceghost/melodica-extension)`, as pianobar names
itself. A User-Agent header is not CORS-safelisted, so it is only sent to an
origin the extension holds a host permission for (Pandora's, or an endpoint
the user granted on the options page); a tuner or relay reached through CORS
keeps the browser's UA (the diagnostics say which, per request). Whether a
Pandora login with *valid* credentials now succeeds from the extension has
not been observed: CI has no account, and the only real-Pandora evidence is
the bogus-credentials probe (1002) from Node and from the installed Firefox
extension.

## Bridge protocol (as implemented in `src/content.imba`)

Two layers, both specified in `docs/BRIDGE.md`: the request relay below
(since 0.1.0) and, since 0.3.0, the remote control: a page that posts
`{melodica:1, type:'subscribe'}` receives `{type:'state', state}` on every
change of the background's `playerState` (without audio URLs) and may send
`{type:'command', id, action, …}` for the player actions above; the `ready`
announcement carries `player: true`. A page that never subscribes sees exactly
the old protocol.

The content script listens for `message` events on `window` where
`event.source === window`, `event.origin === location.origin` and
`event.data && event.data.melodica === 1`.

| direction | message |
| --- | --- |
| page → ext | `{melodica:1, type:'hello'}` |
| ext → page | `{melodica:1, type:'ready', name:'melodica-extension', version:'<manifest version>'}` (also posted once when the content script loads, for a page that loaded first) |
| page → ext | `{melodica:1, type:'request', id:<string>, search:'?method=auth.partnerLogin&…', body:<Uint8Array>}` |
| ext → page | `{melodica:1, type:'response', id, ok:<fetch ok>, status:<number>, body:<Uint8Array>, error:<string|undefined>}` |

Only a `search` that starts with `?`, has no `#`, and whose `method` matches
`/^[a-z]+\.[A-Za-z]+$/` is forwarded; anything else is answered with
`ok:false, status:0, error:'method not allowed'`. The content script sends
the body to the background base64-encoded (Chrome's messaging is JSON); the
background POSTs it to `<endpoint><search>` with `content-type: text/plain`,
`credentials: 'omit'`, `redirect: 'error'`, and returns the status and the
raw bytes. All messages are posted with `location.origin` as the target.

## Proof

CI (`.github/workflows/ci.yml`, ubuntu-latest) builds the wasm core from
Nelua (the fork is cloned at a pinned commit and built with `make`), bundles
the Imba, runs `core/test.mjs`, lints the Firefox build with `web-ext`,
packages the zips, and then runs `tests/smoke-extension.spec.mjs`, with
`tests/fake-account.mjs` (access and the optional account, docs/ACCOUNT.md) on
the local "spacegho.st" server, which:

1. starts [melodica-tuner](https://github.com/Spaceghost/melodica-tuner) with
   the `Spaceghost/melodica-tuner@v1` action (a stand-in `tuner.pandora.com`,
   strict mode: unknown fields, bad `syncTime` and plain-http logins are
   refused);
2. launches Playwright's Chromium headed under `xvfb-run` with
   `--load-extension`/`--disable-extensions-except` pointing at the built
   `dist/chrome`, `--ignore-certificate-errors` for the tuner's throwaway CA,
   and `--host-resolver-rules` mapping `spacegho.st` to a local https server;
3. opens the options page and sets the endpoint to the tuner's https URL;
4. opens `popup.html` as a tab, signs in with the tuner's user, asserts the
   fixture's stations render, starts the first station and asserts that no
   tab opened, that the popup shows the song, that the background's state is
   `playing` with the tuner's audio URL and that an offscreen document exists
   and no player tab; closes the popup and, with no extension page open,
   asks the service worker twice five seconds apart (its `storage.session`
   copy and the offscreen engine's own answer) and requires `playing` with
   the position advanced; opens a new popup (shows the track), then the
   player tab from it (same track, "Playing in the background", no `<audio>`
   element, progress advancing), closes the tab and requires playback to
   continue;
5. loads melodica-web 0.2.0's built page (vendored in `tests/fixtures`) as
   `https://spacegho.st/melodica/app/`, asserts the content script's
   `ready` announcement, posts `hello` and gets `ready`, posts a `request`
   for `auth.partnerLogin` and gets a `response` with `ok:true`, `status:200`
   and a `Uint8Array` body whose JSON has `stat:"ok"` and a
   `partnerAuthToken`, and that a request for `?method=../../admin` is refused;
   then the page `subscribe`s, must receive the playing state with no audio
   URL in it, and pauses and resumes the music with `command`s;
6. reads the tuner's `/__tuner/log` and requires successful
   `auth.partnerLogin` (twice: the extension's own and the bridged one),
   `auth.userLogin`, `user.getStationList`, `station.getPlaylist` and a
   `GET /audio/…`.

It writes `tests/artifacts/smoke-extension.json` (`ok`, `platform:
"browser-extension"`, `summary`, `when`, `steps`, `tuner`, plus `browser`,
`engine`, `extension`, `audio`, `bridge`, `blocked`, `failedRequests`) and
`smoke-extension-login.png`, `smoke-extension-stations.png`,
`smoke-extension-playing.png` (the popup after starting a station),
`smoke-extension-popup-playing.png` (a new popup, with every other page
closed in between), `smoke-extension-player-tab.png`,
`smoke-extension-bridge.png`. Step 3 also asks
the background (message `state`) which endpoint it will use and requires the
tuner's, so a save the worker did not pick up fails there, not at login.

### Firefox (`smoke-firefox`)

A third job installs the current Mozilla Firefox from `packages.mozilla.org`
(unpinned, like Brave) with geckodriver (latest release) and drives it
headless through `selenium-webdriver` (Playwright's Firefox cannot load
extensions). `tests/smoke-firefox.mjs` installs `dist/firefox` as a temporary
add-on (`installAddon(dir, true)`; the moz-extension UUID is pinned through
the `extensions.webextensions.uuids` pref, and extension pages are loaded
from Firefox's chrome context because WebDriver refuses `moz-extension://`
navigations), reads `browser.permissions.getAll()` in the options page and
requires `https://tuner.pandora.com/*` among the granted origins (Firefox
grants MV3 `host_permissions` at install; this checks it for a temporary
install too), requires `browser.storage.session` and a `background.scripts`
event page, then repeats the tuner proof: endpoint set, popup login, the
fixture's stations, a station started from the popup with no tab opening and
the background state `playing`; then the tab leaves the extension for
`about:blank` for 45 s, longer than Firefox's event-page idle timeout, and a
new popup must find the state still `playing` with the position advanced by
about that long (`audio.noPage`); the optional player tab shows the same
track with no `<audio>` of its own and closing it stops nothing (a PulseAudio
null sink stands in for a sound card). Then the
Firefox-only part: the endpoint is reset to Pandora, bogus credentials are
submitted, and the popup must show "Pandora rejected auth.userLogin (code
1002: invalid login). Wrong email address or password." while the background
log (read through the options page's diagnostics) shows `auth.partnerLogin`
answered `stat=ok` and `auth.userLogin` answered `code=1002`. The same job
first runs `scripts/real-pandora-probe.mjs`, the client and wasm core alone in
Node, against the real Pandora and requires code 1002 there too; its report is
`smoke-firefox-node-probe.json`. The report is `smoke-firefox.json`
(`platform: "firefox"`, `browser` = the `firefox --version` line, `engine`
from WebDriver, `permissions`, `sessionStorage`, `background`, `audio`,
`realPandora` with the code and the log lines, `log`) plus
`smoke-firefox-login.png`, `smoke-firefox-stations.png`,
`smoke-firefox-playing.png`, `smoke-firefox-real-pandora.png`. The bridge to
the web page is not exercised in Firefox (the page would have to be served as
`https://spacegho.st` on port 443). The release job requires all three
reports and lists them in `SHA256SUMS`.

### The same proof in Brave (`smoke-brave`)

A second job installs Brave from `https://brave-browser-apt-release.s3.brave.com/`
(its signing key, `stable main`, nothing pinned; the version is logged and
written to the report) and runs the identical spec with `MELODICA_BROWSER=brave`:
Playwright's `chromium.launchPersistentContext` with
`executablePath: /usr/bin/brave-browser`, headed under xvfb, the same
`--disable-extensions-except`/`--load-extension`, `--no-first-run`,
`--no-default-browser-check`. Brave Shields are left at their defaults. The
report is `smoke-brave.json` (`platform: "brave"`, `browser` = the
`brave-browser --version` line, `engine` = the Chromium version Brave reports
over CDP, and `blocked` = every request Brave answered with
`net::ERR_BLOCKED_BY_*`; the test fails if one of those is the extension's,
the tuner's or the page's) plus `smoke-brave-login.png`,
`smoke-brave-stations.png`, `smoke-brave-playing.png`, `smoke-brave-bridge.png`.
Playwright launches Chromium-family browsers with `--disable-component-update`,
which in Brave leaves Shields without any filter list (`brave://components`
says "No components are installed"); in Brave the spec drops that flag, waits
up to a minute before the proof for `brave://components` to show Brave's
default filter components as `Updated`, and records them with their versions in `shields`
(`filtersLoaded`, `waitedMs`, `components`). `filtersLoaded` is recorded, not
asserted: read it before taking `blocked: []` as a statement about Shields.
The `release` job requires both reports to say `ok: true` and attaches both
sets, covered by `SHA256SUMS`.

Why Shields do not need a per-site exception here: the extension's own
requests (login, stations, playlist, audio) are issued by the service worker
and the player page, both extension contexts, which Shields do not filter; the
bridge is a content script that only relays the page's `postMessage`s to the
worker, so the page itself makes no request to the tuner. The Brave runs
recorded `blocked: []` with `filtersLoaded: true`.

Rehearsing in Brave exposed two races that Chromium's timing had hidden, both
fixed in 0.1.2: the options page rendered its form before the stored settings
had arrived, so a value typed in that window was overwritten (the form now
waits for them); and a `storage.onChanged` event that landed while the worker
was still booting was dropped (it now waits for the boot and applies on top).
Before the fixes the Brave smoke failed about half the time with the
extension still pointed at `tuner.pandora.com`.

Rehearsed on 2026-11-07 in the bak container `melodica-ext` (Playwright
Chromium 158 and Brave Browser 157.1.99.55 from Brave's apt repository, tuner
0.1.2, headed under xvfb): `ok: true` in both, all sixteen steps, "Slow Light"
by Aurora Fields on QuickMix at readyState 4, the bridged `auth.partnerLogin`
answered `stat: "ok"`, `?method=../../admin` refused, and in Brave
`blocked: []`. The authoritative runs are the ones on GitHub Actions for the
tagged commit; see the release notes for the run of each tag.

### What this does and does not prove

- Proven by the tag's run: the exact `dist/chrome` build loads in Chromium
  and in Brave and the exact `dist/firefox` build in Mozilla Firefox, their
  options/popup/player pages work, the wasm core frames requests the strict
  tuner accepts, audio plays from the tuner in the background with no
  extension page open (5 s measured in Chromium and Brave, 45 s in Firefox),
  the player tab is a view that can be closed without stopping it, the
  bridge protocol round-trips through the content script and background and
  remote-controls the playback (Chromium and Brave), and the real Pandora
  accepts the request framing (the bogus-credentials probe).
- **Background playback is measured for seconds, not hours.** Chrome's
  closing of an idle offscreen document and its recreation, a Firefox
  event-page termination later than 45 s, and the behaviour across a browser
  restart or a system sleep are not exercised in CI.
- **Brave: the stable of the day, Shields at defaults, on Linux.** The job
  does not pin Brave, so each run proves whatever `brave-browser` apt
  installed then (the version is in the report). Shields were not configured;
  `blocked: []` says nothing of ours was refused during the run, and
  `shields.filtersLoaded` says whether Brave's filter lists were in place
  before it (waited for, recorded, not asserted). Brave on Windows or macOS,
  Brave's `.crx` drag-install and Brave's policy install have not been
  exercised.
- **Real Pandora, without an account.** The `smoke-firefox` job talks to
  `tuner.pandora.com` itself twice per run, from Node and from the installed
  Firefox extension: `auth.partnerLogin` succeeds and `auth.userLogin` with
  bogus credentials is answered with code 1002, which proves the framing
  (query, envelope, syncTime, User-Agent) is one Pandora accepts. CI has no
  Pandora account, so a login with valid credentials, the station list and
  playback against Pandora are not observed anywhere in CI.
- **Firefox is run, headless, on Linux, as a temporary add-on.** The `.xpi`
  install prompt, a signed install, Firefox on Windows or macOS and the bridge
  in Firefox are not exercised.
- **Access and the account, against fakes.** All three browser jobs
  check, against `tests/fake-account.mjs`: an email the server refuses is
  not logged in and Pandora is not asked; the spacegho.st sign-in (begun and
  finished in the background around a browser tab, GitHub chosen on the fake
  authorize page) and sign-out, with token refresh and rotation in Chromium and
  Brave; withdrawn access stops the music and signs out of Pandora. The
  `release` job checks each report's `access` and `account`. The real
  spacegho.st, a real GitHub sign-in and launchWebAuthFlow's own window are
  not exercised in CI.
- **Signature, no stores.** The `.xpi` is signed by Mozilla on the unlisted
  channel (the sign step's log and `META-INF/` in the file are the evidence);
  there are no store listings and no store jobs (`docs/STORES.md`). No job
  installs the `.xpi` or `.crx` in a browser; Firefox's install prompt and
  Chrome's policy install have not been exercised.
- The three browser jobs install whatever Mozilla and Brave ship on the day
  and Playwright's pinned Chromium; the versions are in the reports.
- The web page's side of the bridge is being implemented in melodica-web; the
  smoke test drives the protocol from the page context itself, so it proves
  the extension's half against the agreed protocol, not the shipped page's
  use of it.
- The tuner's strict mode validates fields, `syncTime` and https, but it is
  not Pandora: rate limits and geo-blocking are not exercised.

## Privacy

The password is Blowfish-encrypted by the wasm core as Pandora requires and
sent only to the configured endpoint (Pandora by default) from the extension
itself. It is stored only when "remember password" is ticked. The session
tokens live in `storage.session` (cleared when the browser closes). The bridge
forwards bytes between the page and the endpoint and stores nothing.

The access check sends the email you log in to Pandora with (and, when you
are signed in to spacegho.st, that account's access token) to
`spacegho.st/oauth/melodica/access`, before the login and then at boot and
hourly; an email that is not on the list is sent to the admin as an access
request. The password never goes there. The optional spacegho.st account's
tokens are kept in `storage.local` under `account` until you sign out (which
revokes the refresh token) or the server refuses them; they are sent only to
spacegho.st. Nothing is logged with tokens or codes in it.

The last song (Resume, above) stays on this device: sealed in `storage.local`, its
audio in Cache Storage; neither leaves the browser.

Scrobbles (above, Options) go to `spacegho.st/scrobble/api/me/listens` with the
melodica token; turning scrobbling off stops them and empties the queue.

## License

MIT. The Blowfish constants and the request framing follow
[melodica.h](https://github.com/Spaceghost/melodica.h) (MIT; its libpiano
compatibility layer is under `LICENSE.libpiano`, Lars-Dominik Braun).
