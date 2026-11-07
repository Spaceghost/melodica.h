# melodica-web

A Pandora client that runs in the browser. The protocol lives in
[melodica.h](https://github.com/Spaceghost/melodica.h)'s portable C
implementation of the historical libpiano API, compiled to WebAssembly; the
page around it is plain HTML, CSS and one ES module. No framework, no bundler,
no external scripts.

Hosted copy: <https://spacegho.st/melodica/app/>

## How it works

```
browser                                   relay                     Pandora
  app.js ── mw_begin(json) ──► melodica.wasm
         ◄─ {urlPath, postData} ─┘  (Blowfish-encrypted body)
  fetch POST <relay>/?method=…  ───────────► POST tuner.pandora.com/services/json/?… ──►
         ◄───────────────────── JSON unchanged ◄────────────────────────────────────
  mw_finish(json) ──► melodica.wasm parses it, updates session / stations / playlist
         ◄─ {result: {...}}
  <audio src=audioUrl>  ───────────────────────────────────────► Pandora's CDN
```

- `src/piano_wasm.c` wraps `PianoInit` / `PianoRequest` / `PianoResponse`
  from `vendor/melodica.h/compat` in a handful of C functions that take and
  return UTF-8 JSON strings. All libpiano state (partner session, user
  session, station list, current playlist) stays in C.
- `web/piano.js` loads the module and runs the request/response cycle,
  including the two-step login (`auth.partnerLogin`, then
  `auth.userLogin`) and the automatic re-login on an expired session.
- `web/app.js` is the UI: login, station list, now playing, play/pause, skip,
  thumbs up/down, tired, explain, search + create station, delete station,
  volume (scaled by the track's replay gain), quality, keyboard shortcuts
  like pianobar (`space`, `n`, `+`, `-`, `t`, `e`, `(`, `)`, `s`, `/` to
  filter stations), a numbered play log with in-place ratings, Media
  Session metadata so OS media keys work, auto-advance and a fresh playlist
  when the queue runs out.
- The relay only forwards bytes. Pandora's audio URLs are plain https CDN
  links that an `<audio>` element plays cross-origin without CORS.
- `web/bridge.js` is the extension bridge: the
  [melodica browser extension](https://spacegho.st/melodica/#melodica-extension)'s
  content script can carry the API calls straight to tuner.pandora.com
  instead of the relay (see "Extension bridge" below).

### Exported C API (`dist/melodica.js`, `createMelodica()`)

| function | returns |
| --- | --- |
| `mw_init()` | 0, or a libpiano status on failure |
| `mw_begin(requestJson)` | `{"ok":true,"urlPath":"/services/json/?method=…","secure":true,"postData":"…"}` or `{"ok":false,"status":n,"code":n\|null,"error":"…"}` |
| `mw_continue()` | same shape; re-issues the pending request after `mw_finish` answered `continue:true` |
| `mw_finish(responseBody)` | `{"ok":bool,"continue":bool,"status":n,"code":n\|null,"error":str\|null,"result":{…}}` |
| `mw_stations()` | `{"stations":[…]}` from the cached list |
| `mw_logged_in()` | 1 when a user session exists |
| `mw_version()` | static string |
| `mw_free(ptr)` | frees a string returned by the functions above |

Request actions (`{"action": …}`): `login` (`user`, `password`), `stations`,
`playlist` (`stationId`, `quality` = `high`/`medium`/`low`), `rate`
(`trackToken`, `stationId`, `rating` = `love`/`ban`), `tired`, `explain`,
`search` (`query`), `createStation` (`token`, optional `type`),
`deleteStation` (`stationId`).

`status` is the libpiano `PianoReturn_t`; `code` is Pandora's error code when
`status >= 1024` (for example `1001` invalid auth token, `1002` invalid
partner login, `12` licensing restriction / outside the US, `1039` rate
limited). `status` `5` is a wrong email or password.

## Build

Needs emscripten. Locally the build is meant to run in a container or on CI,
not on the workstation:

```sh
git clone --recursive https://github.com/Spaceghost/melodica-web
cd melodica-web
scripts/build.sh        # emcc on PATH, or an emsdk checkout at $EMSDK (default /opt/emsdk)
scripts/check.sh        # parses the modules, checks relative URLs / no inline script
```

`scripts/remote-build.sh` syncs the tree into an emsdk Incus container
(`bak`/`melodica-emsdk` by default), builds and tests there and pulls `dist/`
back, so nothing is compiled on the workstation.

`dist/` then holds `index.html`, `app.js`, `piano.js`, `bridge.js`, `app.css`,
`melodica.js`, `melodica.wasm`, `LICENSE`, `LICENSE.libpiano`,
`THIRD_PARTY_NOTICES.md`, `VERSION`.

## Test

```sh
node tests/node-smoke.mjs
node tests/node-unit.mjs
node tests/bridge-unit.mjs
```

Runs the compiled module in Node against the live relay. Without an account
it performs a real `auth.partnerLogin` through the relay and checks that the
module then produces an encrypted `auth.userLogin` request. With
`PANDORA_USER` and `PANDORA_PASSWORD` set it also logs in, lists stations,
fetches a playlist and HEADs the first audio URL. `MELODICA_API` overrides
the relay URL. `node-unit.mjs` needs no network: it feeds canned
Pandora-shaped responses (a `syncTime` produced by `tests/tools/synctime.c`
with the partner key) to the module and checks request building, result
serialisation, error mapping and the automatic re-login. `bridge-unit.mjs`
needs no network either: a fake window plays the extension's content script
and checks the hello/ready handshake, the message filter, request/response
pairing by id, the timeout with fallback to the relay, HTTP errors through
the bridge and the `?api=` / bridge / relay precedence in `PianoClient.post`.

GitHub Actions runners are answered by a Cloudflare challenge page instead of
the relay, so in CI the smoke test runs with
`MELODICA_SMOKE_ALLOW_RELAY_BLOCK=1` and reports that case as "not provable
here" rather than failing; the live partner login is proven from other
networks (it was observed from a bak container and from the workstation).

### Browser test

```sh
npm install
npx playwright install --with-deps chromium
npx playwright test                                            # dist/ on a local server, live relay
MELODICA_APP_URL=https://spacegho.st/melodica/app/ npx playwright test   # the hosted page
```

`tests/browser.spec.mjs` opens the page in Chromium, waits for
`#app[data-view="login"]` (set only after `melodica.wasm` instantiated and
`mw_init` returned 0), checks the login form, records console messages, page
errors, failed requests and `securitypolicyviolation` events, then submits
`nobody@example.invalid` / `wrong`. Without an account the correct outcome is
Pandora's code 1002 on `auth.userLogin`, which libpiano maps to "Wrong email
address or password." in the form; that proves wasm → Blowfish body → relay →
Pandora → parsed error. The local variant serves `dist/` under
`/melodica/app/` with the site worker's CSP (plus the relay origin in
`connect-src`) and `?api=` pointing at `MELODICA_API`. Screenshots land in
`tests/artifacts/login-screen.png` and `login-error.png`;
`hosted-login-*.png` there are from a run against the hosted 0.1.1 on
2026-11-05 (Chromium 156 in a bak container: no Cloudflare challenge, no
console errors, no CSP violations, both relay calls HTTP 200, "Wrong email
address or password." in the form).
`MELODICA_BROWSER_ALLOW_RELAY_BLOCK=1` turns the challenge-page outcome into
a skipped test, as the smoke test does.

`tests/bridge.spec.mjs` injects a fake content script into the page world
(it answers `hello` with `ready` and proxies each bridge `request` to the
relay with `fetch`), then asserts the status line says
"direct via melodica extension 0.1.0", that the sign-in round trips were
carried by the bridge (the script logs each request's method, id and body
length), and that a page opened with `?api=` never sends `hello` and reports
"via … relay (?api=)". Screenshots: `bridge-login-screen.png`,
`bridge-login-error.png`.

### Full flow against melodica-tuner

`tests/smoke-tuner.spec.mjs` runs the built client against
[melodica-tuner](https://github.com/Spaceghost/melodica-tuner), a stand-in
`tuner.pandora.com`, so the whole flow is proven without a Pandora account:
sign in, station list (the fixture's seven stations), pick the first station,
now-playing title/artist, and the `<audio>` element reaching
`readyState >= 2` with a `playing` event and a non-zero `currentTime`
(Chromium is launched with `--autoplay-policy=no-user-gesture-required`).
It then reads the tuner's `/__tuner/log` and requires successful
`auth.partnerLogin`, `auth.userLogin`, `user.getStationList`,
`station.getPlaylist` and a `GET /audio/...`. The tuner is strict by default
and refuses logins over plain http, so the client is pointed at the tuner's
https listener (`?api=https://127.0.0.1:8443/services/json/`) and the browser
context ignores its throwaway CA; audio and art are plain-http URLs on the
http listener, like Pandora's CDN, and the test's CSP allows them.

```sh
MELODICA_TUNER_DIR=../melodica-tuner npx playwright test tests/smoke-tuner.spec.mjs
```

starts the tuner itself (`python3 -m tuner --tls-auto`); in CI the
`Spaceghost/melodica-tuner@v1` action starts it and the test reads
`TUNER_HTTPS_URL`, `TUNER_HTTP_URL`, `TUNER_USER`, `TUNER_PASSWORD`. Output:
`tests/artifacts/smoke-web.json` (the minisite's report shape: `ok`, `steps`,
`summary`, the audio element's state) and `smoke-web-login.png`,
`smoke-web-stations.png`, `smoke-web-playing.png`. Rehearsed on 2026-11-05
in a bak container (Playwright Chromium 156, tuner 0.1.0): logged in, seven
stations, "Slow Light – Aurora Fields" on QuickMix, readyState 4, `playing`
fired, the 64 kbps AAC-LC `.m4a` decoded. Repeated on 2026-11-06 for the
0.2.0 redesign with the same result. This proves the client against the
tuner, not against Pandora.

CI (`.github/workflows/ci.yml`) builds and runs the smoke test on every push;
`browser.yml` builds `dist/` and runs the browser test against it (the hosted
page only on `workflow_dispatch` with `hosted: true`, since GitHub runners
may be challenged; the first run on 2026-11-05 was not) and the tuner smoke
test; `release.yml` builds `v*` tags into `melodica-web-<version>.tar.gz`
(top-level directory `dist/`), a source tarball and `SHA256SUMS`, runs the
tuner smoke test against that exact `dist/`, and publishes a GitHub release
with `smoke-web.json` and the three screenshots attached (the release is not
published when the smoke test fails).

## Self-host

Serve `dist/` as static files under any path (`index.html` uses relative
URLs only). Make sure `.wasm` is served as `application/wasm` so streaming
compilation works.

The client needs a relay that accepts `POST <relay>/?<query>` with the raw
request body (`content-type: text/plain`), forwards it to
`https://tuner.pandora.com/services/json/?<query>` and returns the response
unchanged with `access-control-allow-origin: *` (and answers `OPTIONS`). The
relay must run from a place Pandora serves, i.e. the US. The relay URL is:

1. `?api=https://host/path/` in the page URL (same origin only, or on a
   local dev host; it also disables the extension bridge), else
2. the extension bridge when a content script has answered `ready`, else
3. `data-api="…"` on the `<script type="module" src="app.js">` tag, else
4. `../api/` resolved against the page URL (so `/melodica/app/` talks to
   `/melodica/api/`).

The footer status line names the active transport: "via spacegho.st relay"
or "direct via melodica extension 0.1.0".

### Extension bridge

A WebExtension whose content script runs on the app's URL can offer a direct
path to Pandora. The page side (`web/bridge.js`) speaks same-window
`postMessage`, so it needs no `connect-src` change and no extension
permission from the page:

- On startup the page posts `{melodica: 1, type: 'hello'}` to
  `location.origin`.
- The page accepts only `message` events with `event.source === window`,
  `event.origin === location.origin` and `event.data.melodica === 1`.
- `{melodica: 1, type: 'ready', name, version}` switches the transport to
  the bridge; it may also arrive unsolicited (the script loaded late).
- Each API call is `{melodica: 1, type: 'request', id, search, body}` with
  `search` the query string (`?method=…&…`) and `body` a `Uint8Array` of the
  request body; the reply is `{melodica: 1, type: 'response', id, ok,
  status, body: Uint8Array, error}`.
- A request with no response after 20 s, or a response with no HTTP status
  (`status: 0` plus `error`), falls back to the relay for that request. An
  HTTP or Pandora answer through the bridge is final.

### Content Security Policy

The page works under:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; media-src https: http:; connect-src 'self'; font-src 'self'
```

`'wasm-unsafe-eval'` is required to compile the module; `img-src https:` for
cover art; `media-src https:` for Pandora's CDN; `connect-src` must include
the relay's origin if it is not same-origin.

### Hosting notes (spacegho.st)

The hosted copy is mirrored from the GitHub release into R2 by
`melodica-site/scripts/sync.mjs` and served by the site worker with the CSP
above. Cloudflare's bot protection on that zone injects an inline detection
script into the HTML, which the CSP blocks (a console warning, nothing
more), and answers datacenter clients such as GitHub Actions runners with a
challenge page instead of the relay. Browsers on ordinary connections and
Node on a workstation reach the relay fine; if real users ever see
"The relay answered HTTP 403", relax the bot rules for `/melodica/api/`.

## Privacy

Your Pandora email and password are encrypted by the wasm module (Blowfish,
as Pandora's API requires) and sent only to Pandora, through the relay or
directly through the melodica browser extension. The relay forwards and
stores nothing; the login screen says so under the form. The page keeps your email in
`localStorage`; your password is stored there only if you tick "remember
password on this device", and the form says so in plain words. Nothing else
leaves the browser.

## License

MIT (this repository). The libpiano-compatible sources in
`vendor/melodica.h/compat` are under `LICENSE.libpiano` (MIT, Lars-Dominik
Braun); see `THIRD_PARTY_NOTICES.md` for the rest.
