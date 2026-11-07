# melodica on iPhone and iPad (Safari Web Extension)

The iOS build is the same extension in Apple's wrapper: a small containing app
(`melodica.app`, bundle id `st.spacegho.melodica`) whose only job is to carry
the Safari Web Extension (`melodica Extension.appex`,
`st.spacegho.melodica.Extension`). It is **never** published: no App Store, no
App Review, no TestFlight link. Friends install the unsigned `.ipa` from the
release by sideloading it with their own Apple ID (README, "iPhone and iPad").

## Layout

| Path | What |
| --- | --- |
| `scripts/safari.mjs` | derives `dist/safari` from `dist/chrome` (manifest changes below) |
| `scripts/package.sh safari [ver]` | runs it and zips `melodica-extension-<ver>-safari.zip` |
| `ios/extension/safari-auth.js` | content script for the GitHub sign-in return page (Safari has no `identity` API) |
| `ios/melodica/` | the Xcode project, generated once by `xcrun safari-web-extension-converter dist/safari --project-location ios --ios-only --no-open --bundle-identifier st.spacegho.melodica --app-name melodica` (Xcode 26.6 on GitHub's `macos-latest`, run 42355683850) and then edited: the converter's fourteen per-file references into `dist/safari` were replaced by one build phase, **Copy dist/safari**, that copies the whole folder into the extension on every build, so a new or renamed file needs no project change; the deployment target is iOS 17.0 (`browser_specific_settings.safari.strict_min_version` 17.0); user-script sandboxing is off so that phase may read `dist/` |
| `ios/scripts/build.sh device\|simulator` | `xcodebuild` for a device (Release, arm64, `CODE_SIGNING_ALLOWED=NO`, packaged as `release/melodica-<ver>-unsigned.ipa` = `Payload/melodica.app` zipped) or the simulator (Debug, ad hoc `-` signature) |
| `ios/scripts/sim-smoke.sh` | the simulator proof, writes `tests/artifacts/smoke-ios.json` and `smoke-ios-*.png` |
| `ios/scripts/sign-adhoc.sh` | inactive signing hook (below) |
| `.github/workflows/ios.yml` | `web` (ubuntu: core, extension, `dist/safari`), `ios` (macOS: device + simulator builds, proof), `attach` (ubuntu, tags only: waits for ci.yml's release, uploads the `.ipa` and the proof, extends SHA256SUMS and the notes) |

`ios.yml` runs on `v*` tags and `workflow_dispatch` only, never on push: the
repository is private, so macOS minutes bill at 10x. One macOS job, no matrix;
everything that does not need a Mac runs on ubuntu.

## Manifest for Safari (`dist/safari/manifest.json`)

- `background`: `{"scripts": ["bg.js"], "persistent": false}`. iOS rejects a
  persistent background page and has no offscreen documents; Safari unloads the
  background page when idle. `bg.js` has no top-level `import`/`export`, so it
  loads as a classic script.
- `permissions`: `offscreen` and `identity` dropped (Safari has neither);
  `commands`, `update_url`, `version_name` dropped (no shortcuts on iOS; the app
  update brings the extension update); `browser_specific_settings` is only
  `{"safari": {"strict_min_version": "17.0"}}`.
- One more content script, `safari-auth.js` at `document_start` on
  `https://spacegho.st/melodica/app/*`.
- If the build has an engine host page script (`offscreen.js`), `player.html`
  loads it too: on Safari the player tab is where the `<audio>` element lives.

## GitHub sign-in on Safari

`browser.identity.launchWebAuthFlow` does not exist in Safari, and the auth
Worker accepts only its own web app page or the Chrome/Firefox identity hosts
as `return_to`. So on Safari the background opens
`https://spacegho.st/melodica/auth/start?return_to=https://spacegho.st/melodica/app/`
in a tab; the Worker sends that tab back to `/melodica/app/#melodica_token=…`,
and `safari-auth.js` hands the token to the background, which keeps it only
while a sign-in it started is pending. Requires GitHub sign-in, as on every
other platform. **Not exercised in CI**: the simulator run does not open the
popup (below), and no CI job does the real GitHub round trip on any platform.

## Playback with Safari in the background (what works where)

**(a) The player tab (this release).** The player page runs as an ordinary
Safari tab (`safari-web-extension://…/player.html`) and owns the `<audio>`
element; Media Session metadata and actions (play, pause, next track) are set
from the engine, which is what puts title, artist, art and controls on the lock
screen and in Control Center. iOS Safari keeps a page's media element playing
when Safari goes to the background or the screen locks, and keeps the web
process alive while audio plays. The documented weak point (WebKit bug reports
across iOS 15–17) is starting the **next** track while the screen is locked:
`play()` after an `ended` event may be refused or the JS may be suspended, so
playback can stop at a song boundary. Whether an extension page gets the same
treatment as a web page is not documented by Apple. **None of this is proven**:
the simulator run never starts playback (it cannot open the popup), it has no
lock screen media session to inspect from CI, and no real device has run this
build.

**(b) Native playback (the path to true background audio, not built).** The
containing app plays the stream with `AVPlayer` under the `audio`
`UIBackgroundModes` entry and an `AVAudioSession` of category `.playback`, with
`MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` for the lock screen. The
extension stays the Pandora client (login, playlists, ratings, the gate): it
sends `{op: "play", url, title, artist, album, art, trackToken}` and the queue
through `browser.runtime.sendNativeMessage` to `SafariWebExtensionHandler`,
which writes them to a shared App Group container (`group.st.spacegho.melodica`)
and posts a Darwin notification; the app picks the queue up and plays it,
writing its state (position, ended, next requested) back to the group for the
extension to read on its next wake. Caveats: the handler runs in the extension
process, not the app, so the app must already be running (or be opened once
from the extension via a `melodica://` URL) to take the audio; Pandora's audio
URLs expire, so the app must ask for a new playlist through the extension when
the queue runs out, which needs Safari awake, or the Pandora client (and the
wasm core, through JavaScriptCore) must move into the app. App Groups need an
entitlement that SideStore/AltStore re-sign with the user's team, which they
support. Estimate: 2–3 days for app playback + messaging + lock-screen
controls; another 2–3 days to move playlist refresh into the app so playback
survives Safari being suspended for long; testing needs a real device.

## Signing hook (inactive)

When the repository has the secrets `IOS_CERT_P12` (base64 .p12 of an Apple
Distribution certificate), `IOS_CERT_PASSWORD` and `IOS_PROVISION_PROFILE`
(base64 ad hoc profile; a wildcard App ID such as `TEAMID.st.spacegho.*`, or add
`IOS_PROVISION_PROFILE_EXTENSION` for the extension's own profile), `ios.yml`
sets `HAS_IOS_SIGNING` at job level (as ci.yml does with `HAS_AMO`) and
`ios/scripts/sign-adhoc.sh` re-signs the unsigned build as
`melodica-<ver>-adhoc.ipa`, which installs on the devices listed in the profile
with no sideloading app. None of these secrets exist, so the step has never
run; it needs Jack's $99 developer account. Ad hoc is limited to 100 devices of
each type per year, has no public listing, and sends nothing to App Review.
Internal TestFlight (up to 100 members of the developer team, no review, no
public link) would also stay private but is not set up.

## The simulator proof (`smoke-ios.json`)

`sim-smoke.sh` boots the newest iPhone simulator on the runner (iPhone 17 Pro,
iOS 26.5 with Xcode 26.6 so far), installs the simulator build, launches the
app (`smoke-ios-app.png`), asks `pluginkit` whether the system registered the
Safari extension, adds melodica-tuner's CA to the simulator keychain and opens
Safari (`smoke-ios-safari.png`). Then it **turns the extension on** the way
Settings stores it: with Safari stopped, it sets `Enabled = true` and grants the
requested origins and permissions in the extension's entry of
`Library/Safari/WebExtensions/Extensions.plist` in Safari's data container
(found by the first run's discovery; `smoke-ios-discovery.txt` in the run's
artifacts shows the file before and after). It opens the real
`https://spacegho.st/melodica/app/`, takes `smoke-ios-bridge.png`, and reads it
with the Vision framework (`ios/scripts/ocr.swift`): the step passes only when
the page's status line says "direct via melodica-extension <version>", which
the web player prints only after the extension's content script answered its
hello. That is the proof that the extension loads and runs in iOS Safari.

Not exercised on iOS: the popup, the options page and the player tab (opening
them needs a tap on Safari's extensions menu, or the extension's
`safari-web-extension://<unique id>/` base URL, which Safari does not publish
and the run did not find), so the Pandora login against melodica-tuner,
playback, the Safari GitHub sign-in and the background-audio behaviour are
**not proven**. Turning the extension on by editing Safari's plist is a
simulator technique; on a device the user flips the switch in Settings. A
real-device install is not provable in CI at all.
