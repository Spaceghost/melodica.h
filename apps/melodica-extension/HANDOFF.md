# Handoff (melodica-extension)

## Mobile DJ station selection — 2026-11-09

- Final native 0.9.14 private-playback/full-page bridge proof passed (2.6 minutes) using isolated tuner ports 18443/18080 and actual web 0.13.12. Native room evidence also reports 0.9.14 passed. Primary proof is preserved in `/var/home/jack/workspaces/melodica-next-station-primary-smoke.json`; combined release status is `/var/home/jack/workspaces/melodica-next-station-release-status.json`.

- Signing retry is queued for 2026-11-09 23:51 UTC (15:51 Pacific) in user timer `melodica-extension-0914-sign-retry.timer`. Its script is `/var/home/jack/workspaces/melodica-extension-0914-sign-retry.sh`; it retries only failed jobs in CI 42710960096 and iOS 42710959928. Service-account GitHub access was verified through systemd, and user lingering is enabled. The successful CI/iOS hooks drive normal self-hosted catalog publication.
- Retry v0.9.14 only. Intermediate v0.9.12/v0.9.13 builds were not published and are superseded. Web 0.13.12 is already live and verified against official release files.

- Broadcasting DJs can select a station while the current room track continues. Per the user’s choice, the selection queues for their next DJ track; no room play is replaced or ended by station selection.
- Engine queueStation preserves the current song, audio position and station. The next turn discards the old station queue and fetches from the selected station. Pending selection is persisted in engine and last-play state.
- The DJ keeps station choices in playerView during a broadcast; listeners do not see private station choices. Controls and copy say “queued for your next DJ track.” Existing stylesheets are unchanged.
- Built as 0.9.14 with shared UI b5d4feddc03ab557. The experimental immediate switch and service replacement API were reverted. Mozilla signing remains throttled until about 2026-11-09 23:49 UTC; 0.9.10 remains the verified signed public extension until the new release is published.
- Validation: production Imba engine/room routing/player-view regression tests, production web queue/next-song tests, 27 web remote browser tests including 390px DJ/listener controls, and focused native Chromium room lifecycle. Physical mobile devices and real Pandora login are not claimed.

## Startup cleanup patch — 0.9.3

- v0.9.3 at 500faea fixes the 0.9.2 Chromium startup cleanup regression. Engine-state reports no longer close the document; explicit room cleanup rechecks activity after awaiting engine creation.
- Exact CI artifact 42622435195 passed build/package/unit checks and Mozilla unlisted signing. All five package SHA256 digests were verified before creating the release.
- Focused 0.9.3 Chromium private playback/export/import test passed in 7 seconds. The complete browser suites remain separate; do not claim they are green yet.
- Publisher 42623541080 completed successfully. Both live catalogs report extension 0.9.3; Melodica web remains 0.13.3. Existing styling is preserved.
- Web real-extension job 129179881903 was rerun after the previous attempt used 0.9.2 and hit the same startup bug. Final result is still pending.


<!-- extension-publication:start -->
## Extension catalog publication

- v0.9.10 is published at https://spacegho.st/extensions/#melodica-extension and https://spacegho.st/melodica/extension/.
- Mozilla unlisted signing is preserved. Both browser update feeds and eight public installable downloads passed checksum verification.
- Both catalogs passed browser checks at 390 and 1280 pixels; the Melodica catalog contains only its browser extension and keeps the player bar pinned.
- The Worker release manifests were updated in R2; all other Melodica projects were preserved. No player or Worker code was deployed by this publication.
- Evidence: https://github.com/Spaceghost/melodica-extension/actions/runs/42711948269.
<!-- extension-publication:end -->

Updated 2026-11-09. Self-hosted 0.9.2 published and verified; full tag browser suites remain in progress.

## Full release cycle checkpoint

- 0.9.2 is live in both R2 manifests and browser update feeds. Eight public package downloads match CI SHA256SUMS; both catalogs passed at 390 and 1280 pixels without browser errors or horizontal overflow. All 11 other Melodica projects were preserved. Evidence: publisher run 42621298090 and `/tmp/melodica-extension-v092-publication/report.json`.
- The Firefox XPI is Mozilla-signed for the unlisted channel; no public Mozilla listing was created. Exact tagged artifacts came from successful build job 129169817053 in CI run 42620130575.
- `publish.yml` and `scripts/release/` implement automatic post-CI publication, late iOS resync, scheduled catch-up, batched uploads, cached downloads, public verification, handoff updates and the public app snapshot. See docs/RELEASING.md. The v0.9.2 publisher completed against both catalogs; current publisher and site tests passed in the release validation run.

## Earlier Fedora integration checkpoints

- Branch `wip/fedora-extension-integration` in `~/Projects/melodica-extension-integration` combines transfer/copy commits 28109d6 and 3d9a428 with current master e0851c4. Merged to master and tagged v0.8.8 after CI 42591268373 passed build, Chromium, Brave and Firefox. Release run 42593828496 passed build and Chromium/Brave/Firefox, then failed publication because the self-hosted release job had no Node. The exact tagged artifacts and all three proof reports were downloaded; the unchanged tag release-proof script passed locally and every checksum verified. GitHub v0.8.8 was then published with 61 assets from those artifacts. iOS run 42593828451 built the IPA and installed/launched it in the simulator, but Safari never detected the running extension; popup, bridge and playback were not verified. Its attachment uploaded the IPA/proof/checksums, then failed to update notes because Node was absent. The notes were corrected manually with those limits. All 66 published assets were downloaded again and every listed checksum verified; the 60 original package/proof assets match CI byte for byte. Feed sync is pending. No Worker/R2 deployment from Fedora. User explicitly permits Fedora builds/tests, overriding older workstation restrictions below.
- Private engine transfer and bounded cached-audio copying are unchanged from the tested handoff branch. CI now runs the seven transfer/copy unit cases, installs Chromium system libraries on self-hosted runners, and requires successful UI freshness verification. Generated release access text now reflects Pandora sign-in and optional spacegho.st sign-in.
- Shared UI pin bumped to the latest PUBLIC content hash 7b2e55dadefebdee. Service replay fix e0c05db1178ede82 is merged but not deployed; bump again after it is published. Do not claim that unpublished pin is served.
- Local 0.8.8 candidate builds with the verified released 0.8.7 core (14961 bytes); `git diff 5b22d59 HEAD -- core` is empty. CI rebuilt the core from its pinned toolchain; both CI browser builds match the local/released binary SHA-256 09b736044c6ba0bf7ede2ccdd448e952a0b685883f7e29bbb574176ba44ee0a5. Core vectors (30), account (37), scrobble (50), update (44), parser (3) and transfer/copy (7) checks passed.
- The combined web/real-extension suite passed all six with local candidate df2f438 after web startup corrections. Web alone passed all 69 checks. The exact tagged Chrome ZIP passed five of six native checks (`combined-extension-tagged-0.8.8.log`), including cached-byte transfer after disabling the extension, but one first idle reload took 1564 ms and failed its unchanged 1500 ms ceiling. The trace delayed in web tab coordination before bridge startup; the web branch now removes a redundant Web Lock query and is revalidating. Do not report this package/web combination fully green yet. Next: inspect release CI, verify the published artifact, sync feeds and recheck the deployed artifact. Keep the original timing/ownership assertions. Main-branch/Worker publication and browser-store publication are distinct; never publish to stores. Cloudflare work on Fedora remains dependent on `npx -y wrangler@4.135.0 login`.

- Follow-up workflow fix explicitly installs Node 22 in both release and iOS attachment jobs. Existing browser jobs already install Node. The published tag is unchanged; no force push or retag. Evidence: `~/workspaces/crew-e2e-fedora/extension-release-v0.8.8-verification.log`.

## CI runner correction

- The first 42591268373 attempt ran on GitHub-hosted Ubuntu because LINUX_RUNNER was unset, and the required public UI manifest returned 403. The existing online fedora-melodica-extension runner was verified. Repository variable LINUX_RUNNER is now [self-hosted, linux, x64, fedora]; rerunning the failed build assigned it there, verified the UI pin, and all three browser jobs passed. Do not restore a warning-only freshness check.

## Live

| Version | Commit | What |
| --- | --- | --- |
| 0.8.7 | 5b22d59 | Shared Scrobbles UI pinned by content hash 5d0e0d0e496df10f, with a staleness check in CI. latest.json gets 403 from GitHub runners, and the check then warns. Map "Play in melodica" goes through play-seed. Deployment toast in the player tab and a deployment line in the popup. |
| 0.8.6 | 8ffb7c8 | listen:// links: player-tab prompt (never autoplays), omnibox `listen`, Firefox web+listen, iOS listen://, "Copy listen link". `queue` (Up next) in the bridge state and the player tab. |
| 0.8.5 | 288c0eb | Only 403 scrobbling_off turns scrobbling off. The queue is kept and flushed. The popup shows a failure line. play-seed. station_name and submission_client_version on listens. No single-side accents. |
| 0.8.4 | 9c4f9dc | Resume on this device, Sign in with GitHub, album art as Pandora gives it. |

Each release has 55 assets. The extensions feeds and the melodica site carry it, and melodica.h has the snapshot.

## Live e2e (tests/live-e2e.sh, Chromium on bak, 2026-11-09)

Run with Pandora replaced by melodica-tuner, /oauth/ faked, and /scrobble/ going to the real spacegho.st as the throwaway account u_e2eext00001 (bearer from the scrobble agent's access_token).

Proven:
- background playback with 0 extension pages;
- playing_now posted 0.5 to 1.1 s after play, with art_url, station_name and the client version;
- now playing on spacegho.st within 0.9 to 2.9 s, with art and art_cached;
- thumbs up and down.

Not proven live:
- a single at half the track: the tuner's songs stayed 10 s; the single logic is unit-tested;
- Brave and Firefox live;
- real GitHub sign-in;
- crew views.

The CI smokes (fake spacegho.st) cover detection, remote control, resume after a worker kill, and the feeds.

When finished, tell the scrobble agent so it erases u_e2eext00001. Do not erase it yourself.

## Queue

- Native Chrome extension re-enable into an already-open web player is fixed on
  `wip/fedora-extension-enable`: the background scans eligible existing tabs on
  startup and reinjects the bridge on activation/completed navigation. The
  manifest adds only `scripting`; existing static match routes bound injection
  to `/melodica/` and `/listen/` on the approved origin. Playback transfer
  carries validated genome traits and a same-SID/token listen marker, including
  numeric listened seconds and sent state. The extension resumes from its exact
  cached blob and keeps one engine. Focused native Chromium proof on 2026-11-09
  passed against the integration web dist: exact title and monotonic position,
  one offscreen audio target, page audio paused/empty, zero Pandora JSON/media
  refetches, and no page relay or auth-policy requests. Evidence is tracked in
  `tests/evidence/extension-reenable.json`; the Playwright log artifact remains
  ignored in `tests/artifacts/extension-reenable.json`.
  Transfer/copy unit tests pass 8/8. Firefox re-enable was not tested.

- Native Rooms 0.9.2 is published from `wip/fedora-engine-handoff` at tag commit
  `8fb29b508cc23cb41b248957c2d7e0df11e26cba`. It adds a full-tab
  extension Rooms view and native background/offscreen room ownership. Room
  controls route through the extension-owned shared session; the player view
  exposes sanitized room playback and locks private controls during an active
  DJ turn. Search/recent, room API, clock forwarding, account sign-out cleanup,
  bounded public snapshots and per-device room publisher identity are wired
  through the extension bridge. Each install keeps a non-secret stable room
  device ID; the server snapshot distinguishes the local publisher from other
  devices using the same account. The final shared UI/media assets are pinned
  to `29ff42b9a043f925` (shared commit
  `8937f0fea181310c2106abdd237418ee8d19b6f4`); all three digests match the
  immutable public manifest. Native device identity distinguishes a room's
  local broadcaster from another device using the same account; fresh room
  restoration carries local pause state. Offscreen documents use
  `AUDIO_PLAYBACK` plus `WEB_RTC`, and close explicitly when neither a room nor
  active private playback needs them.
  The focused local Chromium room smoke passed on the immediately previous
  shared media pin: relay audio receipt (1082 ms), opt-out, page-unmount
  continuity, search/recent, sign-out leave, and zero Pandora JSON/media
  refetch. Evidence is in `tests/evidence/extension-rooms.json`; the smoke's
  worker-stop/restart branch was disabled and remains unverified. Final bundle
  build and 45 focused room/state/transfer/release tests passed. Shared
  room-session recovery tests passed 8/8; backend turn/source tests passed
  31/31. Full tag browser run 42620130575 is still in progress; its build,
  signing, package, unit, UI pin, and lint steps passed, but do not report the
  full Chromium/Brave/Firefox suite green until those jobs finish.

- Fedora candidate `wip/fedora-engine-handoff` adds private `playback-export` /
  `playback-import` and bounded `playback-copy` commands for the web client's engine handoff. It is
  based on the live 0.8.7 source; no release, push or deployment was performed.
  `npm run test:transfer` passes seven engine/validation/byte-copy cases. The focused
  Chromium/tuner smoke passes with a verified 0.8.7 released core and candidate
  JS bundles: all three handoff/copy/disable cases passed in 19.6 s. Import and
  session offer make zero Pandora JSON API calls. After a URL expires, 82,947
  bytes transfer in six chunks matching the original private cache's SHA-256.
  Disabling the real extension through Chromium's UI emits `gone` and closes
  offscreen/background targets; a stopped background alone emits no `gone`.
  Toggle preserves Pause when an offscreen engine is recreated. Exported `played`
  distinguishes heard songs from unheard paused imports, including recreation.
  Run locally with `MELODICA_HEADLESS=1 MELODICA_TEST_HTTPS_PORT=18443
  MELODICA_TEST_HTTP_PORT=18080 npx playwright test tests/smoke-extension.spec.mjs
  --grep 'handoff:|copy:|disable:'`. Results are in ignored
  `tests/artifacts/{handoff,playback-copy,runtime-invalidated}.json`.
  Account, scrobble, update and listen-parser units also passed. Firefox/Safari
  handoff remain unverified. The full existing Chromium smoke was not green:
  it exposed the recreated-engine toggle bug (fixed here); the unchanged 0.8.7
  baseline later timed out waiting for a slot. Cold-start and resume cases passed
  together after making each test configure its tuner; a later run under host IO
  pressure failed the short-fixture same-song resume timing check. Do not report
  the complete regression suite as green. Final focused log:
  `/tmp/melodica-extension-handoff-copy-final.log`.

1. The pending contract is `defineElements` (optional). The mountX functions still work.

## Rules

- Never build or run on the workstation. Use the bak Incus container `melodica-ext` through scripts/remote-sync.sh.
- Kill tuners before a smoke: `ssh bak "incus exec melodica-ext -- sh -c 'pkill -f [m]elodica-tuner; true'"`.
- Run one smoke at a time.
- GitHub Actions is the proof. Report only what was observed.

## Native restart and authenticated departure correction

- Candidate 0.9.7 uses shared media pin 92145388e550904a (b11769ed86e906236a6f8dab445a9513916232c1). The shared connection/session now return the pending Leave attempt, so native sign-out retains its authorization until departure completes, while local audio stops immediately. Two deferred-request regression checks are included in the backend's 18 passing connection/session checks.
- Focused native smoke passed twice with `MELODICA_NATIVE_RESTART_PROOF=1`, observing actual CDP stopped/running lifecycle events, the same retained offscreen target, no duplicate join, resumed live audio, opt-out, recent/search, and sign-out departure. Evidence `tests/evidence/extension-rooms.json` records the real version and tuner ports. The prior boot-log counter was replaced with direct lifecycle evidence.
- Extension 0.9.6 full Chrome/Brave/Firefox tag CI 42627039152 passed. The focused 0.9.7 run is not a full browser report; its global smoke JSON is intentionally not publication evidence.
- Actual Cloudflare SFU provider check in the backend passed using the shipped adapter/gateway/SQLite authority and a disposable SFU app: three audible receivers, median source lags 113/132/127 ms and 19 ms between receiver medians. Temporary app and private credentials were deleted. Physical devices were not measured.
