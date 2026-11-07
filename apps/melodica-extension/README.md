# melodica-extension

A Pandora WebExtension for Chrome, Brave and Firefox (Manifest V3). Two jobs:

- **A standalone player.** Sign in from the toolbar popup, pick a station, and
  the music plays in an extension tab (`player.html`) that keeps the `<audio>`
  element alive after the popup closes.
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
popup.html / player.html / options.html         bg.js (service worker)         Pandora
  Imba tags ── runtime.sendMessage ──────────► Pandora client (pandora.imba)
                                                │ core.envelope(json) ──► melodica_core.wasm (Nelua)
                                                │ ◄── Blowfish-ECB hex ──┘
                                                └─ fetch POST https://tuner.pandora.com/services/json/?method=… ──► 
                                                   ◄──────────────────────────── JSON unchanged ──────────────────
  <audio src=audioUrl>  ─────────────────────────────────────────────────────────────────────────► Pandora's CDN

https://spacegho.st/melodica/app/   content.js
  page ── postMessage {melodica:1,…} ──► bridge ── sendMessage ──► bg.js ── fetch ──► Pandora
```

Nothing is published to the Chrome Web Store or AMO. The releases carry an
`.xpi`, a `.crx` and unpacked-extension zips, and
<https://spacegho.st/extensions/#melodica-extension> (the self-hosted store,
repository Spaceghost/extensions-site) mirrors them with install buttons,
checksums, the CI proof and the update feeds.

## Install

Buttons and current steps: <https://spacegho.st/extensions/#melodica-extension>.

- **Firefox:** `melodica-extension-<ver>.xpi`, served there as
  `application/x-xpinstall` so Firefox offers its install prompt. Since v0.1.4
  the file is **signed by Mozilla** (CI runs `web-ext sign --channel unlisted`
  with the repository's AMO credentials; the release notes say "Signed by
  Mozilla" and the file carries `META-INF/mozilla.rsa`), so release Firefox
  128+ installs it. If signing ever fails for a version, that release's `.xpi`
  is unsigned and the notes and `docs/STORES.md` give the fallback routes.
  gecko id `melodica-extension@spacegho.st`; update feed
  `https://spacegho.st/extensions/dl/melodica-extension/updates.json`.
- **Chrome Web Store / Edge Add-ons:** `docs/STORES.md`. On each tag CI uploads
  `melodica-extension-<ver>-cws.zip` (the Chrome build without `update_url`)
  to an unlisted Chrome Web Store item (Chrome, Brave, and Edge with "Allow
  extensions from other stores") and to a hidden Edge Add-ons product, when
  the `CWS_*` / `EDGE_*` secrets exist; the listings themselves are created
  once by hand. The store page shows the store buttons once the ids are set.
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
  install needs AMO signing, which has not been done.

The `-chrome`, `-cws` and `-firefox` zips are the same build; the Firefox one keeps
`browser_specific_settings.gecko` (id `melodica-extension@spacegho.st`,
`update_url` to the store's `updates.json`) and `background.scripts`, the
Chrome one drops them so Chrome does not warn and carries the top-level
`update_url` to the store's `update.xml` (ignored for an unpacked load, which
is how the CI smoke runs); the `-cws` one is the Chrome build without
`update_url`, for the Chrome Web Store and Edge Add-ons, which reject it.

## Layout

| Path | What |
| --- | --- |
| `core/melodica_core.nelua` | the wasm core (freestanding Nelua); `core/pi_hex.nelua` is Blowfish's pi table copied from melodica.h |
| `core/test.mjs`, `core/ref-blowfish.mjs` | Node unit test: libpiano's vector from melodica.h `tests/crypt.c`, an independent JS Blowfish for cross-checks, hex, syncTime, the envelope, the arena |
| `src/core.imba` | JS wrapper around the wasm exports |
| `src/pandora.imba` | JSON API v5 client: partnerLogin, userLogin, station list, playlist, feedback, sleep, explain, search, create/delete station; one re-login on code 1001; errors name the call and code ("Pandora rejected auth.userLogin (code 1002: invalid login). Wrong email address or password."); the client User-Agent (below) |
| `src/bg.imba` | background: session (in `storage.session`), every Pandora request, player-tab management, the bridge relay, the diagnostics log (last 200 lines in `storage.session`, no tokens) |
| `src/popup.imba`, `src/player.imba`, `src/options.imba`, `src/ui.imba`, `src/shared.imba` | the pages and shared tags |
| `src/content.imba` | the bridge content script for `https://spacegho.st/melodica/app/*` |
| `public/` | `manifest.json` (one template, two outputs), the three HTML pages (no inline scripts), `theme.css` |
| `scripts/build-core.sh` | Nelua → C (`--target wasm32-unknown-unknown`) → `clang -nostdlib` → audits exports/imports |
| `scripts/build.mjs` | esbuild + `imba/compiler` → `dist/chrome`, `dist/cws`, `dist/firefox`, `build/node/{core,pandora}.js`; generated icons; CSP guards |
| `scripts/real-pandora-probe.mjs` | no-account probe of the client + wasm core against the real `tuner.pandora.com` from Node: partnerLogin, syncTime, userLogin with bogus credentials, expects code 1002 (below) |
| `scripts/package.sh` | the zips (`-chrome`, `-cws` without `update_url`, `-firefox`), the `.xpi`, the `.crx` (via `crx3`, key from `$CRX_KEY`), the source tarball, `SHA256SUMS` |
| `scripts/edge-publish.sh` | upload + publish a package through the Edge Add-ons REST API v1.1 (used by the `publish-edge` job) |
| `docs/STORES.md` | store publishing: what CI does, the one-time dashboard steps, the privacy text, the Firefox fallback |
| `scripts/crx-id.mjs` | the Chrome extension id of a key: first 128 bits of SHA-256 over the DER SubjectPublicKeyInfo, hex mapped to a–p |
| `tests/smoke-extension.spec.mjs` | the Playwright proof (below) in Playwright's Chromium or, with `MELODICA_BROWSER=brave`, an installed Brave; `tests/fixtures/melodica-web-dist` is melodica-web 0.2.0's built page |
| `tests/smoke-firefox.mjs` | the Firefox proof (below): Mozilla Firefox through geckodriver + selenium-webdriver, `dist/firefox` as a temporary add-on, the tuner, then the real Pandora with bogus credentials |
| `.github/workflows/ci.yml` | build (+ AMO signing) → `smoke` (Chromium), `smoke-brave` (Brave stable from Brave's apt repository) and `smoke-firefox` (Mozilla Firefox from packages.mozilla.org, plus the real-Pandora probe) → release on `v*` tags → `publish-cws`, `publish-edge` (skip without their secrets) |

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
node scripts/build.mjs --version 0.1.0            # dist/chrome, dist/cws, dist/firefox, build/node/{core,pandora}.js
node core/test.mjs                                # 30 checks
npx web-ext lint --source-dir dist/firefox --self-hosted
CRX_KEY=/path/to/key.pem scripts/package.sh 0.1.0 # release/*-{chrome,cws,firefox}.zip, .xpi, .crx, -src.tar.gz, SHA256SUMS (no .crx without CRX_KEY)
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
- `host_permissions`: `https://tuner.pandora.com/*`, `https://*.pandora.com/*`. `optional_host_permissions`: `https://*/*`, `http://*/*` for an endpoint override (the options page offers a "Grant access" button; without it the endpoint must allow CORS, which melodica-tuner does).
- `permissions`: `storage`.
- `content_scripts`: `content.js` on `https://spacegho.st/melodica/app/*`.
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (the wasm needs `'wasm-unsafe-eval'`).
- `browser_specific_settings.gecko.id`: `melodica-extension@spacegho.st`, `strict_min_version` 128.
- The `browser` namespace is used everywhere with `globalThis.browser = globalThis.chrome` as the only polyfill (promise-returning APIs in MV3 Chrome; `onMessage` listeners answer through `sendResponse`).

## Options

- **API endpoint** (default `https://tuner.pandora.com/services/json/`): where
  `POST ?method=…` goes. CI points it at melodica-tuner. Changing it drops the
  session.
- **Audio quality**: high / medium / low, picked from Pandora's `audioUrlMap`
  (falls back to the next available).
- **Remember password**: kept unencrypted in `storage.local`, only when
  ticked; used for the automatic re-login after Pandora's code 1001.
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
packages the zips, and then runs `tests/smoke-extension.spec.mjs`:

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
   fixture's stations render, starts the first station, waits for the player
   tab, asserts the song title/artist and that the `<audio>` element reaches
   `readyState >= 2` and is not paused, and that the popup mirrors the song;
5. loads melodica-web 0.2.0's built page (vendored in `tests/fixtures`) as
   `https://spacegho.st/melodica/app/`, asserts the content script's
   `ready` announcement, posts `hello` and gets `ready`, posts a `request`
   for `auth.partnerLogin` and gets a `response` with `ok:true`, `status:200`
   and a `Uint8Array` body whose JSON has `stat:"ok"` and a
   `partnerAuthToken`, and that a request for `?method=../../admin` is refused;
6. reads the tuner's `/__tuner/log` and requires successful
   `auth.partnerLogin` (twice: the extension's own and the bridged one),
   `auth.userLogin`, `user.getStationList`, `station.getPlaylist` and a
   `GET /audio/…`.

It writes `tests/artifacts/smoke-extension.json` (`ok`, `platform:
"browser-extension"`, `summary`, `when`, `steps`, `tuner`, plus `browser`,
`engine`, `extension`, `audio`, `bridge`, `blocked`, `failedRequests`) and
`smoke-extension-login.png`, `smoke-extension-stations.png`,
`smoke-extension-playing.png`, `smoke-extension-bridge.png`. Step 3 also asks
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
fixture's stations, the player tab's `<audio>` at `readyState >= 2` and not
paused (a PulseAudio null sink stands in for a sound card). Then the
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
up to a minute before the proof for `brave://components` to show the Brave
Default Adblock Filters, Default Privacy Filters and Ad Block Resources Library
as `Updated`, and records them with their versions in `shields`
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
  tuner accepts, audio plays from the tuner, the bridge protocol round-trips
  through the content script and background (Chromium and Brave), and the
  real Pandora accepts the request framing (the bogus-credentials probe).
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
- **Stores.** The `.xpi` is signed by Mozilla on the unlisted channel (the
  sign step's log and `META-INF/` in the file are the evidence); the Chrome
  Web Store and Edge Add-ons jobs run only once their secrets exist and prove
  an accepted upload, not a passed review (`docs/STORES.md`). No job installs
  the `.xpi` or `.crx` in a browser; Firefox's install prompt and Chrome's
  policy install have not been exercised.
- The three browser jobs install whatever Mozilla and Brave ship on the day
  and Playwright's pinned Chromium; the versions are in the reports.
- The web page's side of the bridge is being implemented in melodica-web; the
  smoke test drives the protocol from the page context itself, so it proves
  the extension's half against the agreed protocol, not the shipped page's
  use of it.
- The tuner's strict mode validates fields, `syncTime` and https, but it is
  not Pandora: rate limits, geo-blocking and ad items are not exercised
  (the client skips playlist items without a `songName`/`trackToken`).

## Privacy

The password is Blowfish-encrypted by the wasm core as Pandora requires and
sent only to the configured endpoint (Pandora by default) from the extension
itself. It is stored only when "remember password" is ticked. The session
tokens live in `storage.session` (cleared when the browser closes). The bridge
forwards bytes between the page and the endpoint and stores nothing.

## License

MIT. The Blowfish constants and the request framing follow
[melodica.h](https://github.com/Spaceghost/melodica.h) (MIT; its libpiano
compatibility layer is under `LICENSE.libpiano`, Lars-Dominik Braun).
