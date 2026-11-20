# HANDOFF (melodica-web)

## Walk records — 2026-11-19

Walk records at `/melodica/track/` opens the listener's own Melodica stations and saved walks. The web player records timestamped song changes and private foreground GPS, shows the station a recorded song came from when known, exports a cover and restores GPX with song times. A signed-out visitor can start recording or sign in to play. Both iPhone and Android can import a timed GPX from a separate GPS recorder for screen-locked walks. Legacy game entry links open the journal. `/melodica/apps/` lists all Melodica clients by platform with downloads from the public release mirror. The old Android directory redirects to `/melodica/apps/#android`. Current Epimetheus and Pandoroid APKs play radio independently of the web walking journal.

## Playback regression repair — 2026-11-10

- Web 0.13.14 introduced an unconditional anonymous-CORS media load even though `AudioCopies` already documented that Pandora CDN responses can omit CORS headers. This breaks direct radio playback and the DJ source. Published 0.13.15 restores ordinary media loading and prepares an origin-clean local blob only for DJ capture, using the existing authenticated audio relay. It works without Remember me or Cache API storage and guards pause, stale track and room transitions.
- Shared pin 1c4e3a130d5df8fe (source/build 759176a) is live on Worker 747deac9-f4ba-45dc-a678-2b7619539525. Relay correction waits for a genuinely buffered target rather than seeking to the moving buffer edge; the backend also avoids repeated media account lookups with a bounded one-second lease while always checking live membership/source ownership. The full no-ACAO audio source → RoomHub → audible listener/D1 receipt proof passes. Normal multi-device spread was 83 ms, with temporary 1108 ms spread during an injected network gap.
- All 46 existing local browser checks passed across the normal run and an isolated rerun after concurrent artifact-directory cleanup interfered with account teardown. The new no-ACAO browser proof passes, including audible muted capture, pause cancellation and stale-track protection. Audio-copy/room unit tests pass (19), with the existing Node suites green. New source tests are mandatory release/browser gates. Release CI 42834456948 passed; all 20 official files match the local tested build and the live files (/var/home/jack/workspaces/melodica-cors-repair-web-live.json). Signed extension 0.9.19 and its eight mirrored package checksums/feeds are verified by publisher 42837785705. No CSS or player controls changed.

## Room audio recovery — 2026-11-10

- Web 0.13.14 and signed extension 0.9.18 are released and live. Both use shared UI c29f401fcdc2db66 (source 183061f). Both players load CDN audio in anonymous CORS mode before assigning a source, fixing SecurityError during real media-element capture. Safari sources use the cached Web Audio capture path with a separate speaker monitor and explicit gesture unlock.
- Relay supports ManagedMediaSource, starts receiving on Resume, confirms initialization uploads, and recovers a lost stream header. Publish and monitor stream identities are separate. Polling receivers recognize a recorder restart, including when their old cursor exceeds the new stream sequence. RoomHub preserves only the active play's header and bounded short replay window through hibernation and removes it at play end.
- Room presentation keeps the existing palette/fonts and adds artwork/DJ identity, clock timing, on-air lineup, audience, public sharing and visible Play/Resume/Reconnect actions.
- Validation: 166 shared service unit tests, actual Chromium and Firefox source/CORS capture proofs, WebKit fallback capture, independent four-receiver relay audio with late join/network gap/same-account secondary device, and native extension room tests passed. Web CI 42757477235 and exact-tag extension recovery CI 42760988456 passed. Publisher 42763448991 verified both catalogs/feeds and eight package checksums. All 20 production app files match the official archive (HTML normalized only for Cloudflare security injection); /var/home/jack/workspaces/melodica-room-audio-web-live.json records the checks. The optional combined local RoomSession/RoomHub receipt proof still times out with local media RPC calls taking up to 7.5 seconds; do not call it passed. Physical iPhone/iPad devices are unverified; the iOS IPA build was blocked before startup by GitHub billing.


## Extension remote reconciliation — web 0.13.13

- The app uses the extension's complete room snapshot for the current song, authoritative duration, room play identity, metadata, play log and clock. Listeners see room playback without private Pandora login/station prompts. Room controls and expandable recent/search discovery sit below the existing player.
- Stop DJing keeps room listening; Leave room restores the owner's private track, history and exact reported position. Station selection while broadcasting still queues the next DJ track. Same-account secondary devices use room reactions and cannot change the broadcast's station.
- Room commands carry the active room ID. Command replies repaint the remote immediately. Empty local audio events cannot overwrite the owner's progress or play icon; OS media controls forward to the owner too. Room clocks reject stale updates and retain their receipt anchor across other state pushes.
- Existing typography, palette, artwork and player controls remain. CSS additions only arrange the room controls and hide the private station rail for listeners.
- Web 0.13.13 is released and live. Official build, playback and mandatory remote checks passed in release workflow 42750175765. All 46 local browser checks and Node/unit checks passed. Actual extension 0.9.17 proof includes room progress, metadata, inline recent/search discovery through the owner, route navigation, hidden Pandora prompt, no page audio source, and phone/desktop screenshots. The live scripts/styles/core match all 19 static release files; HTML matches after the normal Cloudflare security-script injection. The filtered web sync preserved extension 0.9.17 and all 11 other projects. Verification: /var/home/jack/workspaces/melodica-remote-01313-live-verification.json.


## Mobile DJ station selection — 2026-11-09

- Web 0.13.12 is published and live. Release workflow 42709500997 passed build, browser smoke and release; all served JS/shared UI hashes match the official release archive.

- The broadcasting DJ can select a radio station during a live room play. Per the user’s choice, selection queues that station for their next DJ track; the current audio, play ID and DJ rotation are unchanged.
- The current track keeps its station and queued songs until the next turn. The next song consumes the selected station and discards the old station’s queue. Pending selection survives the web owner handoff; native selection is persisted with the current engine/last-play record.
- DJ station choices remain visible during room broadcasts; private choices stay hidden from listeners. Existing stylesheets are unchanged. UI confirms “queued for your next DJ track.”
- Uses the existing shared UI b5d4feddc03ab557; the experimental immediate-source replacement was reverted. The v0.13.11 release was cancelled before publication. Ship web 0.13.12 with extension 0.9.14; Mozilla signing remains throttled until about 2026-11-09 23:49 UTC.
- Tests: actual compiled native queue and player-view contracts, production web queue/next-song functions, mobile DJ/listener browser controls, and native room lifecycle. Physical mobile devices and real Pandora login are not claimed.

<!-- extension-publication:start -->
## Extension catalog publication

- v0.9.19 is published at https://spacegho.st/extensions/#melodica-extension and https://spacegho.st/melodica/extension/.
- Mozilla unlisted signing is preserved. Both browser update feeds and eight public installable downloads passed checksum verification.
- Both catalogs passed browser checks at 390 and 1280 pixels; the Melodica catalog contains only its browser extension and keeps the player bar pinned.
- The Worker release manifests were updated in R2; all other Melodica projects were preserved. No player or Worker code was deployed by this publication.
- Evidence: https://github.com/Spaceghost/melodica-extension/actions/runs/42837785705.
<!-- extension-publication:end -->

Updated 2026-11-09 PT. Production is web 0.13.3 (GET verified), source/tag
`4ec3648` / `v0.13.3`. Extension 0.9.2 is released and signed in both catalogs
and update feeds. Publisher 42621298090 passed all eight public download hashes,
both feeds and the 390/1280 catalog checks. The installed 0.8.8 still needs updating.

## Current release state

- The actual v0.12.1 style is preserved. `web/app.css`, `web/index.html`, and the
  existing site stylesheet are unchanged. Shared CSS added only functional room
  search/progress selectors. The extension-page copy now explains Rooms.
- Rooms recents/search/create/invites and playback commands go to the extension
  owner when available. View pages create no room socket/capture/receiving audio.
  Native recent-room IDs are persisted per signed-in account.
- Shared bundle `29ff42b9a043f925` uses the configured SFU for all room sizes,
  with server audio relay on failure/unavailability. DJ-only timing anchors update
  progress separately from full state, preserving drafts and local clock offsets.
- Server Worker `86d1ee98-efbb-4686-a445-0f9d98e937e4` is live. Each device has a
  stable clientId; the active source alone publishes/clocks/ends a play. Other
  devices on that DJ account listen. Source ownership persists between songs;
  idle handoff is explicit through Broadcast from this device. A 60-second lease
  tolerates control-socket loss while authenticated source activity continues.
- Only an eligible idle DJ can choose a source. Broadcasts cannot silently leave
  a room through station/seed/quality changes or private audio error fallback.
  Sign-out leaves/stops the room before app credentials are removed.
- Focused checks: web room host 8/8, backend turn/source 31/31, shared recovery 8/8.
  Build and immutable pin checks pass. The earlier desktop/phone design and exact
  playback-protocol capture checks passed. Native Chrome 0.9.2 relay proof passed
  audio/receipt, opt-out, UI-close continuity, recents/search and sign-out, with no
  Pandora calls. The final source-turn/recovery bundle has separate focused checks.
  Worker restart and physical-device/provider timing remain unverified.
- Broad browser CI continues after shipping. The 0.9.0 extension suites found a
  real options gate issue (username/diagnostics hidden without optional app login);
  0.9.2 corrects it. Web broad run 42617211367 had local-dist/extension-real failures
  under investigation; smoke passed. Do not label these full suites green.
- Production app files and the GH release are 0.13.3. The canonical site Worker
  is 3e6a084c; deploy records/hashes are under ~/workspaces/melodica-web-deploy-0.13.3/.
  Filtered site sync completed and preserved all other projects; the following
  extension publisher updated both catalogs to 0.9.2 and preserved 11 other projects.
- Leaderboard/Rooms anonymous API checks return 401. Leaderboard requires app
  sign-in without a crew restriction. Auth/migrations remain deployed as before.
- Post-publication full checks are queued/running: web CI 42621426300 and browser
  42621429816 against current master; extension tag CI 42620130575 continues its
  browser jobs after the successful signed build. These do not gate publication.
- Next: finish those checks and pending verification,
  refresh snapshots and perform authorized history cleanup LAST. Publisher metadata
  now defers recent independent repo updates instead of holding feeds for 15 minutes.

## Historical checkpoints

The notes below describe earlier candidates and releases; the current state above
supersedes their pending-work and version statements.

## Fedora continuation

- Jack's extension-page requirement is complete in production: `/melodica/extension/` lists only `melodica-extension` and links to `https://spacegho.st/extensions/`, the full browser-extension store. The full store's catalog currently contains only the Melodica browser extension. Both live pages were checked again at 390 and 1280 with no horizontal overflow or page errors; the Melodica player bar stayed pinned. Evidence: `~/workspaces/crew-e2e-fedora/extension-pages-current/report.json` and screenshots. The dedicated page regression passes (five site page tests).
- Release v0.11.3 passed release CI 42581369985 and was observed in production. Another host subsequently published v0.11.4 and v0.11.5; v0.11.5 was published at 2026-11-09 08:09 UTC. Its production version has not been reverified here. Fetch before publishing; default master was 90e411f at the last check. Preserve its Fedora CI settings and silent panel sign-in tests.
- The next queue/artwork patch is on `wip/fedora-up-next` in `~/Projects/melodica-web-up-next`. It renders actual local/bridge queued songs and uses the shared cover helper for player, bar, history and queue. Preserve original HTTP source URLs when hashing artwork; extension `queue.art` is a source alias, not a cached URL. The node_modules symlink is untracked; never commit it.
- ca1d9d6 build/UI-pin CI 42582468369 and browser CI 42582471198 both succeeded, including the real-extension job. Local shared-art validation passed 46 tests before one Resume seek stalled; all four Resume tests then passed separately with unchanged assertions. After merging master 2a32ebe, the first full run passed 51/52, exposing an embedded hub leaderboard sign-in returning to the leaderboard route. The correction saves the actual current pathname; the rebuilt full run passed all 52 checks with unchanged assertions (`up-next-merged.log`). After merging master 90e411f (a shell-test setup correction), the added hub-return regression also passed (`up-next-hub-return.log`). Build/static checks and all five site page tests passed. The next step is CI on the final merged branch, then release if green and the shared branch is quiet.
- The isolated fixture drivers own ports 34443/34080 and terminate their own processes. Do not kill unrelated fixtures on 8443/8080. Emscripten 3.1.74 is at `~/workspaces/melodica-emsdk-fedora`; Fedora builds/tests are explicitly authorized by Jack.
- The exact c3a9d7d CI dist with released extension 0.8.7 passed forty normal reloads; one of three cold starts took about 6.2 seconds to return restored state. Evidence: `~/workspaces/crew-e2e-fedora/real-extension-fedora.log`. Keep investigating extension boot stages; do not loosen timing limits.
- Publication/D1 cleanup on Fedora remains dependent on `npx -y wrangler@4.135.0 login`. Do not deploy the retired melodica-site. The service repository/Worker is now `spaceghost-scrobble`; its independent `/scrobble/` pages must not be reverted to redirects. Test identity u_crewe2etest01 cleanup is still unverified.

## Live

- Last directly observed `app/VERSION`: 0.11.5. Verify current production again before the next release. Deploy only from melodica-web/site.
- The dedicated extension page is live and verified at 390/1280; the full store contains browser extensions only.
- melodica-extension 0.8.7 is the artifact used in Fedora real-extension validation. Its bridge includes queue metadata.
- The shared UI pin is 5d0e0d0e. Independent Scrobbles pages are live under `/scrobble/` and on `scrobble.spacegho.st`; preserve them.

## In progress

- `wip/fedora-up-next`: queued songs, shared artwork fallbacks, hub silent-sign-in return correction. See validation details above.

## Queue (in order)
1. CI freshness checks now run on Fedora; the hourly verified UI pin updater is implemented. Preserve both when merging.
2. (done: 0.11.2.)
3. Multi-tab, one engine (Jack):
   - Use Web Locks with a BroadcastChannel fallback; the engine sticks to the tab that last played.
   - Remotes use the bridge protocol, and a remote's Play resumes in the engine tab.
   - Handoff happens on close or reload, with a one-tap Resume if autoplay is blocked.
   - A new tab becomes a remote before first paint.
   - Remotes and handoffs make zero Pandora, relay or me requests. The shared non-secret state goes in a versioned localStorage key, with TTL caches and cross-tab request leases.
   - Extension appearing or disappearing: hand the state over without refetching.
   - Tests: 3 tabs at 1280 and 390; the engine closing; an engine reload; extension load and unload.
4. Up next list:
   - Show cover via cover(), title, artist and album for each song.
   - Remote mode reads `queue` from bridge state (extension 0.8.6: [{title, artist, album, coverArt, art, duration, trackToken}]).
   - Standalone mode reads the local playlist.
5. listen:// links:
   - The Worker serves /listen/<path> and /listen/?uri= (302 to routeOf, 404 when invalid; parse per melodica-scrobble src/listen-uri.js).
   - registerProtocolHandler('web+listen', …) on a click.
   - Share buttons copy the https form.
6. From the shared ui: drop the game buttons except Spaceghost's season admin control; deployChip/mountDeployToast; pass crew_viewer to mountNav; every art spot goes through cover().
7. Preserve raw art_url (HTTP included); additional_info.station_name is now sent with playing/listens. Never send track tokens. Reconcile current contracts before further payload changes.
8. Last: the history rewrite of melodica-web, melodica-site and melodica.h, after fresh backups (force-push allowed only for this). Add the private fixture address (in 649fe36, site/tests/relay.test.mjs) to --replace-text. Delete test users.

## CI and jobs

- Current observed handles are recorded in the Fedora continuation. Check exact SHAs and results before release.
- Fedora local drivers and logs live under `~/workspaces/crew-e2e-fedora/`. The full regression uses repository fixtures, never real Pandora credentials.
- Other hosts/agents may own shared branches and fixture processes. Fetch and check author/time before every shared push; wait if someone else pushed within about 15 minutes.

## Rules
- Direct pushes. Never force-push, except for the final history rewrite. Never change repository visibility.
- Fedora compilation and testing are authorized by Jack; deploy the Worker from Fedora after login.
- Keep policy details out of UI copy. Store no emails. Report only what was observed.


## Same-device engine candidate (2026-11-09)

- Isolated branch `wip/fedora-single-player`, based on Fedora crew regression `ab1cc4a`. No release, tag or deployment from this branch.
- `web/tabs.js` elects one engine before account/relay startup. Web Locks arbitrate; BroadcastChannel plus a localStorage lease covers browsers without them. Remotes paint the public snapshot and forward commands, account reads and settings to that engine. Pause/Play stays there.
- Public localStorage contains metadata and the six-second lease only. Private session/queue/cache checkpoints use the encrypted vault (or BroadcastChannel memory with Remember off). The WASM session restore also imports stations, so later queue refill works without another station-list call. Vault opens are coalesced and sign-out waits for checkpoint writes.
- Close/reload, back navigation and blocked autoplay preserve the current song and position. Remotes make no relay/me requests in those covered handoffs; cached account reads use a 30-second TTL and in-flight coalescing.
- Requires extension handoff commits `28109d6` + `3d9a428` for full lifecycle transfer. Explicit `gone` means the runtime was invalidated; ordinary bridge silence keeps the page remote. Private bounded `playback-copy` chunks mirror cached bytes into the web Cache API without a media download. SID/token/offset/size/type checks precede cache writes. Actual heard plays, including paused ones with `played:true`, mirror into the encrypted last-song record; unheard paused imports do not.
- Validation: Emscripten build/static checks and five Node suites pass. The credential-free partner smoke passed; its user-login half was skipped because Pandora credentials were not set. Stable playback/remote browser run: **54 passed in 3.6m**. After the narrow `played:true` persistence condition, the actual web-app/extension test passed in **28.6s**: native Chrome disable closed offscreen/background, exact cached-audio SHA256 matched, an expired URL resumed from the transferred blob at the same position, with zero relay/me/policy/media requests during handoff.
- Evidence: `~/workspaces/melodica-tabs-evidence/{browser54.log,build.log,static.log,units.log,copy-fixture.log,real-extension.log,real-extension-expired-copy.json}`. `tests/extension-real.spec.mjs` contains the actual Chrome-disable case; the regular playback suite includes desktop/phone three-tab, close/reload, no-Web-Locks + Remember off, uncertain silence, cached-byte expiry, back navigation and one-tap Resume cases.
- Integrate with the queue/immediacy/protocol/deployment branches, then build and run the combined candidate. Shared UI pin, Worker authorization, publication and final history cleanup remain separate work in the root task.
- melodica-scrobble moved to Spaceghost/spaceghost-scrobble.
- Two tuner insert tests (smoke-playback 281 and 1280) fail on bak even on 0.11.0; investigate.

## Room lifecycle correction and current production

Web 0.13.6 (3def66a6197fe7c11147420a5aca65af896baaea) is live with shared pin 92145388e550904a. Room/session shutdown now returns the pending authenticated Leave attempt before sign-out discards credentials, while stopping local transport immediately. Connection/session checks passed 18/18. Extension 0.9.7 passed the focused native restart/sign-out proof twice: actual CDP stopped/running states, same retained offscreen document and no duplicate room join. Native evidence is tracked in the extension repository.

The actual Cloudflare SFU provider check passed with the shipped adapter/gateway/SQLite authority and a disposable app: one source and three audible receivers, with median source delays 113/132/127 ms. The temporary app and credentials were deleted. Physical devices were not measured. App CSS remains byte-identical to v0.12.1 (SHA256 79ab46d34d468595cc15dc04ba60223f0de1ca6b4dc0d242fae65ac02d34ea59).

## Web departure command propagation (0.13.7)

The final sign-out audit found that the web RoomHost wrapper discarded the shared session's shutdown promise. Both room-leave and room-command leave now await that returned departure attempt before account sign-out continues; the local room view still clears immediately. A deferred-shutdown regression failed on the old wrapper and passes after the fix; all nine focused room-host checks passed. No styles changed.

## Room experience polish (0.13.10)

Web 0.13.10 (`b0e8e5b576674321ae14db216d0b8f9fb2cf3054`) is deployed and released with shared UI pin `b5d4feddc03ab557` (`spaceghost-scrobble` UI commit `9e62510e9c6510ce03f7be3828dd7425f00c9a96`). First-page discovery, latest-search precedence, pagination deduplication, pending actions, durable errors, invitation confirmation and audio-state copy are corrected. The shared UI browser checks pass at 390/1280px, ten web room-host checks pass, and live asset digests match. Both stylesheets remain unchanged; app CSS SHA256 is still `79ab46d34d468595cc15dc04ba60223f0de1ca6b4dc0d242fae65ac02d34ea59`. The UI-only deployment reuses the published 0.13.8 core after verifying identical SDK gitlink, wrapper and build script. Do not replace this app deployment with the older queued 0.13.9 build. Extension tag v0.9.11 carries the same pin, layered over the concurrent player-first/volume/step-down changes.

The official 0.13.10 CI build subsequently matched all 20 deployed files byte-for-byte. Extension 0.9.11 signing hit Mozilla's 429 throttle after its build checks passed: CI `42694425132`, at 20:44:16 UTC on November 9, retry window approximately 23:48:42 UTC. No extension release was created by this task. The signing upload may already exist because validation polling started before the throttle; inspect that version after the cooldown before resubmitting it. The local publication helper stopped without publishing unsigned files.
