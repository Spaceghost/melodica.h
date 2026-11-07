# melodica-web

A Pandora client that runs in the browser. The protocol lives in
[melodica.h](https://github.com/Spaceghost/melodica.h)'s portable C
implementation of the historical libpiano API, compiled to WebAssembly; the
page around it is plain HTML, CSS and one ES module. No framework, no bundler,
no external scripts.

Hosted copy: <https://spacegho.st/melodica/app/>

## GitHub sign-in

The hosted player and the relay it needs require signing in with GitHub, and
only allowed accounts may use them (the Worker in
[melodica-site](https://github.com/Spaceghost/melodica-site) runs the check;
this page only carries the token). GitHub is used for identity only: the OAuth
request asks for **no scopes**, nothing is stored server-side, and the sign-in
screen says so.

What the page does, in order (`web/gate.js`):

1. If the URL fragment carries `#melodica_token=<token>` (the Worker put it
   there after the GitHub round trip), the token is stored in `localStorage`
   under `melodica.github` and the fragment is removed with `replaceState`.
   `#melodica_error=<code>` (GitHub refused, or the exchange failed) is shown
   on the GitHub screen instead.
2. `GET ../auth/me` (`/melodica/auth/me` for the hosted page) with
   `Authorization: Bearer <token>` when there is one.
   - **503** (`auth not configured`): the gate is off; the Pandora login shows.
   - **200, allowed**: the Pandora login shows, with a small
     "GitHub: *login* · sign out of GitHub" line. A refreshed `token` in the
     answer replaces the stored one.
   - **200, not allowed**: the GitHub screen says "melodica is not available
     for your GitHub account (*login*)." with a "Sign out of GitHub" button.
   - **401** (no token, or a rejected one, which is then forgotten): the
     GitHub screen with a "Sign in with GitHub" link to
     `../auth/start?return_to=<this page>`.
   - anything else (unreachable, 404 on a self-host without the Worker): the
     Pandora login shows and the relay decides.
3. Every relay request carries `Authorization: Bearer <token>`. A **401** from
   the relay (`{"stat":"fail","code":-1,"message":"melodica is not available
   for this account: sign in with GitHub"}`) sends the user back to the GitHub
   screen with that message. The extension bridge does not carry the token: the
   extension gates itself.

With `?api=` in the page URL (local development, the tuner smoke test in CI)
the GitHub screen is skipped; a stored token is still sent to the relay.

The token is an HMAC-signed statement from the Worker (`{sub: login, id,
friend, iat, exp (7 days), chk}`; `friend` is the Worker's name for the
allowed flag and is read as `allowed` here); it lives in this browser's
`localStorage` until "sign out of GitHub" removes it. The downloadable apps on
<https://spacegho.st/melodica/> are not affected.

Until the Worker's secrets exist, `/auth/me` answers 503 and the relay is
open as before; see melodica-site's README for the `wrangler secret put`
steps. The real GitHub round trip has not been exercised yet for that reason:
the tests below prove the page against a fake `/auth/me`.

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
  instead of the relay (see "Extension bridge" below), and since extension
  0.3.0 play in the background with this page as its remote ("Remote mode").
- `web/gate.js` is the client side of the GitHub sign-in gate (see above):
  token in, `/auth/me`, token out.

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

`dist/` then holds `index.html`, `app.js`, `piano.js`, `bridge.js`, `gate.js`, `app.css`,
`melodica.js`, `melodica.wasm`, `LICENSE`, `LICENSE.libpiano`,
`THIRD_PARTY_NOTICES.md`, `VERSION`.

## Test

```sh
node tests/node-smoke.mjs
node tests/node-unit.mjs
node tests/bridge-unit.mjs
node tests/gate-unit.mjs
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
`gate-unit.mjs` needs no network: it checks fragment parsing, taking the token
off the URL into storage, every `/auth/me` outcome (503, 401, allowed,
denied, refreshed token, unreachable), sign-out, the `Authorization` header
on relay requests, and a 401 from the relay or the bridge becoming a
`PianoError` of kind `auth` that fires `onUnauthorized`.

The smoke test calls the live relay. Once the relay is gated it needs an
access token in `MELODICA_RELAY_TOKEN` (minted with melodica-site's
`scripts/mint-token.mjs`; the repository secret of the same name feeds CI).
Without it, a 401 ends the test with a clear "not provable here" log line
instead of a failure.

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
a skipped test, as the smoke test does. `MELODICA_RELAY_TOKEN` (see above) is
put in `localStorage` before the page loads so the gated relay accepts the
calls; the hosted variant then adds `?api=` so the GitHub screen is skipped.
Without the token a 401 from the relay skips the login-error test with a log
line. A hosted-only test opens the page without a token and reports
what it sees: the GitHub screen with the live `/auth/start` link, or the
Pandora login when `/auth/me` says 503 (not configured yet); screenshot
`hosted-gate.png`.

`tests/gate.spec.mjs` is the GitHub sign-in gate in Chromium against a fake
Worker (a local server playing `/melodica/auth/me`, `/melodica/auth/logout`
and `/melodica/api/`, no network): 503 shows the Pandora login directly; no
token shows the GitHub screen with the start link and the explanation;
`#melodica_error=` is shown and cleaned; an allowed account's `#melodica_token=`
is stored, the fragment removed, the Pandora login shows with the GitHub line and
`/auth/me` saw the bearer header; a refreshed token replaces the stored one; a
not-allowed account sees the exact "not available for your GitHub account"
sentence and can sign out
(token gone, `POST /auth/logout` seen); a 401 from the relay routes back to
the GitHub screen with the relay's message and the relay saw the bearer
header; with `?api=` the screen is skipped and the token still reaches the
relay. Screenshots: `gate-anonymous.png`, `gate-denied.png`,
`gate-relay-401.png`.

`tests/remote.spec.mjs` is remote mode in Chromium against a fake extension
(a page-world script answering hello with `ready` + `player: true`, subscribe
with a state, and playing a small fake background player that changes state
on commands and pushes every 200 ms while playing; no network): the page
enters remote mode with the status "playing in melodica extension 0.3.0", the
stations come from the state, picking one sends `play` with its token and the
pushed track fills now playing, position advances, play/pause, love, next,
tired, the `n` key, volume, quality and station reload each send the expected
command and the view follows the answer; the `<audio>` element never gets a
source and no relay request is made. An extension without a Pandora session
gets the "sign in in the extension" hint; an extension that ignores subscribe
leaves the page in local mode (hello, subscribe, unsubscribe; then the Pandora
login). Screenshots: `remote-player.png`, `remote-signed-out.png`.

`tests/bridge.spec.mjs` injects a fake content script into the page world
(it answers `hello` with `ready` and proxies each bridge `request` to the
relay with `fetch`, sending `MELODICA_RELAY_TOKEN` as the real extension sends
its own token; its local server answers `/melodica/auth/me` with 503), then asserts the status line says
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

A self-hosted copy without the melodica-site Worker gets a 404 from
`../auth/me` and goes straight to the Pandora login; its own relay decides
who may use it. The "Sign in with GitHub" link points at `../auth/start`
relative to the page, and the Worker only accepts
`https://spacegho.st/melodica/app/` as `return_to`, so a self-host that wants
the gate runs its own Worker.

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

### Remote mode (extension 0.3.0+)

The melodica extension 0.3.0 and later plays music in its background, with no
tab needed. When it is installed the page is an optional view of that
playback and a remote for it, instead of running its own loop. The protocol
is melodica-extension's `docs/BRIDGE.md` ("Remote control"); the page side is
in `web/bridge.js` (`subscribe`, `command`) and `web/app.js` ("remote mode"):

- After the hello/ready handshake (within 1 s of startup) the page sends
  `{melodica: 1, type: 'subscribe'}`. If a `state` arrives within 1 s the page
  enters remote mode; otherwise it sends `unsubscribe` and plays locally as
  before (no extension, or one older than 0.3.0). The wasm loads meanwhile, so
  local mode is not slowed by more than that probe.
- Remote mode shows the player view (`#app[data-mode="remote"]`) drawn from
  the pushed `state` (station list, now playing, position, play/pause, rating,
  volume, quality, queue length) and sends `{type: 'command', id, action, …}`
  for the controls and keyboard shortcuts: `play` (with `station: {token,
  name}`), `toggle`, `next`, `love`, `ban`, `tired`, `volume` (`value`),
  `quality` (`value`), `stations`. Failed `result`s are shown as messages.
- There is no local `<audio>`, no relay request and no Pandora or GitHub
  sign-in on the page in remote mode: the extension holds both sessions and
  gates itself. When it has no Pandora session the page says to sign in in the
  extension.
- Not available remotely (the protocol has no command for them): "why this
  song?", station search/creation, station deletion, and rating earlier songs
  in the play log. The play log lists the songs seen while the page was open.
- The footer reads "playing in melodica extension 0.3.0 · web …".
- The decision is made once, at page load: an extension installed or updated
  later takes effect on the next reload.

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
password on this device", and the form says so in plain words. The GitHub
sign-in (see "GitHub sign-in") adds one more item to `localStorage`: the
signed token naming your GitHub login, until you sign out of GitHub on the
page. Nothing else leaves the browser.

## License

MIT (this repository). The libpiano-compatible sources in
`vendor/melodica.h/compat` are under `LICENSE.libpiano` (MIT, Lars-Dominik
Braun); see `THIRD_PARTY_NOTICES.md` for the rest.
