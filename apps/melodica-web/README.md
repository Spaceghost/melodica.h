# melodica-web

A Pandora client that runs in the browser. The protocol lives in
[melodica.h](https://github.com/Spaceghost/melodica.h)'s portable C
implementation of the historical libpiano API, compiled to WebAssembly; the
page around it is plain HTML, CSS and one ES module. No framework, no bundler,
no external scripts.

Hosted copy: <https://spacegho.st/melodica/app/>

## Access through the spacegho.st relay

The spacegho.st relay can run open (anyone may log in) or by allow-list
(`docs/ACCOUNT.md`, "Relay"); the page handles both. The page side is in `web/piano.js`:

- In allow-list mode, `auth.userLogin` for a login that is not on the list fails with HTTP 403 and
  the relay's message, shown as is under the login form; Pandora is not contacted.
- When it is on the list and Pandora accepts the login, the relay's answer
  carries `x-melodica-access: <token>`. The page keeps it in memory and sends
  it as `x-melodica-access` on every later relay call (not on `auth.*`).
- A 401 from the relay (token missing or expired, 12 h) is handled like an
  expired Pandora session: log in again with the remembered credentials, which
  gets a new token, and retry the call once.
- After each new token the page asks `/oauth/melodica/policy` with it as the
  bearer (unless a spacegho.st account is signed in, whose own token is used)
  and obeys `playback.plus`. A login waits for that answer.

The extension bridge does not go through the relay; the extension does its own
check (`docs/ACCOUNT.md`, "Access check").

## spacegho.st account (optional)

A small "Sign in with spacegho.st" link under the Pandora login connects an
optional spacegho.st account; it is not needed to use melodica. The contract
is `docs/ACCOUNT.md`, the page side is `web/account.js`:

- The account server is the page's own origin. On spacegho.st (and on
  `localhost`, for development and the tests) the page reads
  `/.well-known/openid-configuration`; anywhere else, or when that fails, no
  link is shown and nothing is probed.
- The link starts an OAuth 2.1 authorization code flow with PKCE (S256) as
  the public client `melodica-web`, scope `openid profile`, redirect
  `<origin>/melodica/app/`. On the way back the page checks `state` and
  `iss`, exchanges the code, removes `code`/`state`/`iss` from the address
  bar and keeps `{access, refresh, expiresAt}` in `localStorage` under
  `melodica.account`. Access tokens are refreshed before they expire; refresh
  tokens rotate; `invalid_grant` forgets them.
- At start, after a sign-in and after each Pandora login the page asks
  `/oauth/melodica/policy` with the account's access token and obeys
  `playback.plus` (see "Playlist items"); a 401 is refreshed and retried once. With
  no account the relay's access token is the bearer (see above); no token, or
  any failure, means the default policy. A Pandora sign-in waits for this
  answer, so the policy is known before anything plays.
- The login card shows "spacegho.st: *name* · sign out" and the account menu
  "spacegho.st *name*" with "Sign out of spacegho.st". The name is the
  account's username (from `/oauth/melodica/me`, the policy or userinfo); no
  email is read or shown. Signing out forgets the tokens and revokes the
  refresh token.

The page shows no text about the policy.

## Usernames

After each Pandora login the page asks `GET /oauth/melodica/me`
(`docs/ACCOUNT.md`, "Usernames") with the spacegho.st account's token when one
is signed in, else the relay's access token. The page side is
`web/account.js` (`me`, `setUsername`) and the username section of
`web/app.js`:

- The account chip shows "Signed in" until the answer comes, then the
  username: a generated `listener-…` until one is chosen. Never the email;
  names are set as text, never as HTML.
- While `username_chosen` is false a "Pick a username" sheet opens once per
  login, prefilled with `suggested` (the GitHub login) when there is one, and
  with the `renamed_github` notice when the server sends it. "Not now" (or
  Escape) keeps it closed for the rest of the browser session.
- The account menu has a "Change username" field.
- Both check the format first (3 to 24 of `a-z 0-9 - _`, starting and ending
  with a letter or digit) and otherwise show the server's `error_description`
  (409 taken, 422 reserved or blocked, 423 locked, 429 too many changes) next
  to the field.
- A 401 `invalid_token` or 404 `unknown_user` forgets a spacegho.st account's
  tokens; with the relay's token it ends the Pandora login and the login card
  says "Your melodica session has ended; log in again."
- In remote mode the extension's account is the extension's; the page shows
  no username controls.

`tests/account-unit.mjs` covers the calls; `tests/smoke-playback.spec.mjs`
("usernames through the relay") runs them in Chromium against the fake account
server: the generated name and the sheet with 409, 422 and format errors, a
chosen name changed from the account menu, "Not now" and the notice, and a
revoked relay token.

## Design

The layout is responsive: on desktop a station rail on the left and a wide
player, on phones a single column with a sticky transport bar. The look is
v0.4.0's, in light and dark: two fixed-size body glows, the blurred cover wash
behind the art on desktop, and a shadowed station rail. (0.5.1 to 0.6.0 sized
the glows relative to the window, which painted a wide warm band on the right
of large windows; 0.6.1 restored v0.4.0's.) The stylesheet is `web/app.css`;
melodica-extension copies it into `public/theme.css`. `tests/design.spec.mjs`
screenshots every view at 390x844 and 1280x800; `tests/design-v040.spec.mjs`
renders the player at 1920x1080 and 2560x1440 from this build and from the
v0.4.0 release and fails when they differ in 1% of the pixels or more (status
line and footer masked). `docs/design/` holds the v0.4.0 (`design-v040-*`) and v0.5.1
(`design-v051-*`) shots in light and dark, and the reverted 0.5.0 one-column
experiment (`design-after-*`).

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
- `web/bridge.js` is the link to the
  [melodica browser extension](https://spacegho.st/melodica/#melodica-extension):
  when it is installed it plays in the background and this page is its
  remote ("The melodica extension", "Remote mode" below).
- `web/account.js` is the optional spacegho.st account (see above): PKCE
  sign-in, tokens, the playback policy.

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

`dist/` then holds `index.html`, `app.js`, `piano.js`, `bridge.js`, `account.js`, `app.css`,
`melodica.js`, `melodica.wasm`, `LICENSE`, `LICENSE.libpiano`,
`THIRD_PARTY_NOTICES.md`, `VERSION`.

## Test

```sh
node tests/node-smoke.mjs
node tests/node-unit.mjs
node tests/bridge-unit.mjs
node tests/account-unit.mjs
node tests/inserts-unit.mjs
```

Runs the compiled module in Node against the live relay. Without an account
it performs a real `auth.partnerLogin` through the relay and checks that the
module then produces an encrypted `auth.userLogin` request. With
`PANDORA_USER` and `PANDORA_PASSWORD` set it also logs in, lists stations,
fetches a playlist and HEADs the first audio URL. `MELODICA_API` overrides
the relay URL. `node-unit.mjs` needs no network: it feeds canned
Pandora-shaped responses (a `syncTime` produced by `tests/tools/synctime.c`
with the partner key) to the module and checks request building, result
serialisation, error mapping, the automatic re-login, and the relay access
token (sent after `auth.userLogin`, not on `auth.*`, renewed by a re-login on
401, the 403 message passed through). `bridge-unit.mjs`
needs no network either: a fake window plays the extension's content script
and checks the hello/ready handshake and its repeats, the message filter,
`waitReady` (also for an extension that appears late), that a `ready` without
`player: true` is not a remote, the subscribe repeated until the first state,
and commands paired with results by id; and that the Pandora client has no
extension transport.
`account-unit.mjs` needs no network: it checks discovery (same-origin
endpoints only), the authorize URL (PKCE S256 against RFC 7636's example,
state), the way back (state and issuer checked, code exchanged, the address
bar cleaned), refresh with rotation, a 401 refreshed and retried, every
failure giving the default policy, `invalid_grant`, the account label,
sign-out with revocation, and the policy asked with the relay's access token. `inserts-unit.mjs` is described under "Playlist items".

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
`nobody@example.invalid` / `wrong`. With the relay open, the correct outcome
is Pandora's code 1002 on `auth.userLogin`, which libpiano maps to "Wrong
email address or password." in the form; that proves wasm → Blowfish body →
relay → Pandora → parsed error. With the relay in allow-list mode it is HTTP
403 with "melodica access is by allow-list. Your request has been sent."
instead; both are accepted. Either way the relay sees that address. The local variant serves `dist/` under
`/melodica/app/` with the site worker's CSP (plus the relay origin in
`connect-src`) and `?api=` pointing at `MELODICA_API`. Screenshots land in
`tests/artifacts/login-screen.png` and `login-error.png`;
`hosted-login-*.png` there are from a run against the hosted 0.1.1 on
2026-11-05 (Chromium 156 in a bak container: no Cloudflare challenge, no
console errors, no CSP violations, both relay calls HTTP 200, "Wrong email
address or password." in the form). That run predates the allow-list.
`MELODICA_BROWSER_ALLOW_RELAY_BLOCK=1` turns the challenge-page outcome into
a skipped test, as the smoke test does.

`tests/account.spec.mjs` is the spacegho.st sign-in in Chromium against an
account server on the page's origin (a local server on `localhost`, so the
session cookies behave as on spacegho.st): `tests/tools/fake-account.mjs`,
which implements the contract with the same routes, pages and cookies as the
real Worker, or, with `SPACEGHOST_AUTH_DIR=<spaceghost-auth checkout>`, that
Worker's own `handle()` over its test harness (D1 on `node:sqlite` with its
migrations, a fake GitHub bridge, a recording email binding; only test data
differs: the issuer is the local origin and the redirect URI is registered for
it). It covers: an invite accepted, then "Sign in with spacegho.st" with the
invite's session, tokens, and the policy fetched with the bearer token, for an
email-only account (shown by its name, no GitHub wording); the same account
returning in a fresh browser through the emailed sign-in link; a
GitHub-linked account through "Continue with GitHub" (GitHub's authorize page
answered by the test); a per-account policy change seen on the next start;
sign-out with revocation; no link without an account server. Screenshots:
`account-email.png`, `account-github.png`.

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

`tests/bridge.spec.mjs` injects a fake content script of an extension before
0.3.0 (it answers `hello` with `ready` without `player: true` and would proxy
`request` messages) and asserts the page stays on the relay and posts it
nothing but `hello`, and that a page opened with `?api=` never sends `hello`
and reports "via … relay (?api=)". Screenshot: `bridge-login-screen.png`.

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
unchanged with `access-control-allow-origin: *` (and answers `OPTIONS`). An
allow-list as on spacegho.st is optional: the page sends `x-melodica-access`
only after a login answer carried one. The
relay must run from a place Pandora serves, i.e. the US. The relay URL is:

1. `?api=https://host/path/` in the page URL (same origin only, or on a
   local dev host; it also disables the extension), else
2. `data-api="…"` on the `<script type="module" src="app.js">` tag, else
3. `../api/` resolved against the page URL (so `/melodica/app/` talks to
   `/melodica/api/`).

The footer status line says "via spacegho.st relay", or "playing in melodica
extension 0.5.0" when the extension is the player.

A self-hosted copy has no account server on its origin, so it shows no
"Sign in with spacegho.st" link and uses the default policy.

### The melodica extension

When the melodica extension is installed it is the player, and the page is
only its view and remote (see "Remote mode" below). The page never plays
through the extension on its own, and never uses it as a transport for
Pandora calls: local playback happens only through the relay, when no
extension (0.3.0+) answers. The page side is `web/bridge.js`, same-window
`postMessage` (no `connect-src` change, no extension permission):

- The page posts `{melodica: 1, type: 'hello'}` to `location.origin` at
  startup and again every 250 ms for 3 s, until `ready` arrives.
- It accepts only `message` events with `event.source === window`,
  `event.origin === location.origin` and `event.data.melodica === 1`.
- `{melodica: 1, type: 'ready', name, version, player: true}` (0.3.0+) puts
  the page in remote mode, whenever it arrives: during startup, or later (the
  content script loaded late, or the extension was installed while the page
  was open). A page already playing on its own stops and switches without a
  reload. A `ready` without `player: true` (before 0.3.0) is ignored.
- An explicit `?api=` means that relay and no extension: no hello is sent.

### Playlist items

Pandora playlists can contain inserted audio items: items with an `adToken` instead of a
song. libpiano's parser skips those items, as upstream pianobar does, so
`src/piano_wasm.c` handles them itself:

- a `playlist` reply also lists `plus: [{adToken, position}]`, `position`
  being the number of songs before the ad; `PianoClient.playlist` puts an
  `{isAd: true, adToken}` marker at that place in the song list;
- the action `adMetadata` (`adToken`, optional `quality`) sends
  `ad.getAdMetadata` with `returnAdTrackingTokens` and `supportAudioAds`, and
  answers `{title, companyName, imageUrl, clickThroughUrl, audioUrl,
  audioFormat, adTrackingTokens}` (the asked quality, else the best one
  offered);
- the action `registerAd` (`stationId`, `adTrackingTokens`) sends
  `ad.registerAd`.

Both are authenticated and Blowfish-encrypted exactly like the library's own
requests. The page plays an ad like a song, showing its title, company and
image in the now-playing card with the chip "ad". While an ad plays, next,
love, ban, tired and "why this song?" are disabled, the `n` key does nothing
and the ad is left out of the play log. `ad.registerAd` is sent once the ad's
audio has started. An ad without audio, or whose metadata request fails, is
passed over.

The browser checks exercise playback, account policy, authentication and the requests recorded by the tuner. The attached reports provide the exact observations.

### Remote mode (extension 0.3.0+)

The melodica extension 0.3.0 and later plays music in its background, with no
tab needed. When it is installed the page is an optional view of that
playback and a remote for it, instead of running its own loop. The protocol
is melodica-extension's `docs/BRIDGE.md` ("Remote control"); the page side is
in `web/bridge.js` (`subscribe`, `command`) and `web/app.js` ("remote mode"):

- On `ready` the page shows the player view at once ("Connecting to the
  melodica extension…") and sends `{melodica: 1, type: 'subscribe'}`, again
  every second until the first `state` arrives (the extension's service worker
  may need a while to start). There is no timeout to local playback.
- Before anything is shown the page waits up to 1.5 s for an extension; a
  remembered relay login waits the full 3 s window.
- Remote mode shows the player view (`#app[data-mode="remote"]`) drawn from
  the pushed `state` (station list, now playing, position, play/pause, rating,
  volume, quality, queue length) and sends `{type: 'command', id, action, …}`
  for the controls and keyboard shortcuts: `play` (with `station: {token,
  name}`), `toggle`, `next`, `love`, `ban`, `tired`, `volume` (`value`),
  `quality` (`value`), `stations`. Failed `result`s are shown as messages.
- There is no local `<audio>`, no relay request and no Pandora or
  spacegho.st sign-in on the page in remote mode: the extension holds its
  own sessions. When it has no Pandora session the page shows "Sign in in the
  melodica extension" and a button that sends the `open-login` command (the
  extension opens its login); an extension that does not know the command gets
  "Click the melodica icon in the browser's toolbar to sign in."
- While the page is visible it also asks for the current state every second
  (`subscribe` again), because released extensions (0.5.x) do not push every
  change (not their login; a resume has been seen to arrive seconds late).
- Not available remotely (the protocol has no command for them): "why this
  song?", station search/creation, station deletion, and rating earlier songs
  in the play log. The play log lists the songs seen while the page was open.
- The footer reads "playing in melodica extension 0.3.0 · web …".
- `tests/remote.spec.mjs` covers this with a fake extension (slow first state,
  late extension, no session, extension before 0.3.0);
  `tests/extension-real.spec.mjs` with the latest released extension (Chrome
  build from spacegho.st/extensions, unpacked) against melodica-tuner: the
  page shows the extension's track, play/pause, next, station and volume from
  either side show on the other (timings in `tests/artifacts/extension-real.json`),
  and the page has no `<audio>` source, fetches no audio and makes no relay
  request.

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
directly through the melodica browser extension. The relay never keeps the
password; what spacegho.st records about a login is listed in
`docs/ACCOUNT.md`. The page keeps your email in
`localStorage`; your password is stored there only if you tick "remember
password on this device", and the form says so in plain words. An optional
spacegho.st sign-in (see "spacegho.st account") adds its tokens to
`localStorage` until you sign out of it on the page. Nothing else leaves the
browser.

## License

MIT (this repository). The libpiano-compatible sources in
`vendor/melodica.h/compat` are under `LICENSE.libpiano` (MIT, Lars-Dominik
Braun); see `THIRD_PARTY_NOTICES.md` for the rest.
