# melodica-extension

A Pandora WebExtension for Chrome and Firefox (Manifest V3). Two jobs:

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
  `application/x-xpinstall` so Firefox offers its install prompt. The file is
  **not signed by Mozilla** (the repository has no AMO credentials; CI signs
  with `web-ext sign --channel unlisted` only when the secrets
  `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` exist). Release Firefox refuses
  unsigned add-ons: use Developer Edition, Nightly or ESR with
  `xpinstall.signatures.required=false`, or load it temporarily as below.
  gecko id `melodica-extension@spacegho.st`; update feed
  `https://spacegho.st/extensions/dl/melodica-extension/updates.json`.
- **Chrome / Edge:** `melodica-extension-<ver>.crx` is a CRX3 signed with the
  repository's key (secret `CRX_PRIVATE_KEY`; the public half gives the
  Chrome extension id **`obbahflgghfemmpmjppeibnemibgblbd`**, computed by
  `scripts/crx-id.mjs`). Linux: `chrome://extensions` → Developer mode →
  drag the file onto the page. Windows and macOS block off-store `.crx`
  installs except by enterprise policy (`ExtensionInstallSources` +
  `ExtensionInstallForcelist` with the update feed
  `https://spacegho.st/extensions/dl/melodica-extension/update.xml`, which is
  also the manifest's `update_url`); otherwise load the zip unpacked.

### Install (unpacked)

Download `melodica-extension-<ver>-chrome.zip` or `-firefox.zip` from the
[latest release](https://github.com/Spaceghost/melodica-extension/releases)
and unzip it.

- **Chrome / Chromium / Edge:** `chrome://extensions` → Developer mode → Load
  unpacked → the unzipped folder.
- **Firefox (128+):** `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → pick `manifest.json` in the unzipped folder (it is removed when
  Firefox quits), or `npx web-ext run --source-dir <folder>`. A permanent
  install needs AMO signing, which has not been done.

Both zips are the same build; the Firefox one keeps
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
| `src/pandora.imba` | JSON API v5 client: partnerLogin, userLogin, station list, playlist, feedback, sleep, explain, search, create/delete station; one re-login on code 1001 |
| `src/bg.imba` | background: session (in `storage.session`), every Pandora request, player-tab management, the bridge relay |
| `src/popup.imba`, `src/player.imba`, `src/options.imba`, `src/ui.imba`, `src/shared.imba` | the pages and shared tags |
| `src/content.imba` | the bridge content script for `https://spacegho.st/melodica/app/*` |
| `public/` | `manifest.json` (one template, two outputs), the three HTML pages (no inline scripts), `theme.css` |
| `scripts/build-core.sh` | Nelua → C (`--target wasm32-unknown-unknown`) → `clang -nostdlib` → audits exports/imports |
| `scripts/build.mjs` | esbuild + `imba/compiler` → `dist/chrome`, `dist/firefox`, `build/node/core.js`; generated icons; CSP guards |
| `scripts/package.sh` | the zips, the `.xpi`, the `.crx` (via `crx3`, key from `$CRX_KEY`), the source tarball, `SHA256SUMS` |
| `scripts/crx-id.mjs` | the Chrome extension id of a key: first 128 bits of SHA-256 over the DER SubjectPublicKeyInfo, hex mapped to a–p |
| `tests/smoke-extension.spec.mjs` | the Playwright proof (below); `tests/fixtures/melodica-web-dist` is melodica-web 0.2.0's built page |
| `.github/workflows/ci.yml` | build → smoke → release on `v*` tags |

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
node scripts/build.mjs --version 0.1.0            # dist/chrome, dist/firefox, build/node/core.js
node core/test.mjs                                # 30 checks
npx web-ext lint --source-dir dist/firefox --self-hosted
CRX_KEY=/path/to/key.pem scripts/package.sh 0.1.0 # release/*.zip, .xpi, .crx, -src.tar.gz, SHA256SUMS (no .crx without CRX_KEY)
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
`extension`, `audio`, `bridge`) and `smoke-extension-login.png`,
`smoke-extension-stations.png`, `smoke-extension-playing.png`,
`smoke-extension-bridge.png`. On a `v*` tag the `release` job refuses to
publish unless `ok` is `true` and attaches the report and screenshots next to
the zips.

Rehearsed on 2026-11-07 in the bak container `melodica-ext` (Playwright
Chromium 158, tuner 0.1.2, headed under xvfb): `ok: true`, all sixteen steps,
"Slow Light" by Aurora Fields on QuickMix at readyState 4, the bridged
`auth.partnerLogin` answered `stat: "ok"`, and `?method=../../admin` refused.
The authoritative runs are the ones on GitHub Actions for the tagged commit;
see the release notes for the run of each tag.

### What this does and does not prove

- Proven by the tag's run: the exact `dist/chrome` build loads in Chromium,
  its options/popup/player pages work, its wasm core frames requests the
  strict tuner accepts, audio plays from the tuner, and the bridge protocol
  round-trips through the content script and background.
- **Not a real Pandora login.** CI has no Pandora account and GitHub runners
  are not in the US; the extension has not been observed against
  `tuner.pandora.com` itself. The request shapes are those of pianobar's
  libpiano and melodica-web, both of which work against Pandora, but that is
  inference, not observation.
- **Firefox is linted, not run.** `web-ext lint` passes with 0 errors on
  `dist/firefox`; the extension has not been loaded in a running Firefox.
- **Store publication is not done** (and is not planned here). The `.xpi`
  and `.crx` are packaged from the same `dist/` and checksummed, but no job
  installs them in a browser; Firefox's install prompt and Chrome's
  policy install have not been exercised.
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
