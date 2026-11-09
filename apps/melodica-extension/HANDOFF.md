# Handoff (melodica-extension)

<!-- extension-publication:start -->
## Extension catalog publication

- v0.9.2 is published at https://spacegho.st/extensions/#melodica-extension and https://spacegho.st/melodica/extension/.
- Mozilla unlisted signing is preserved. Both browser update feeds and eight public installable downloads passed checksum verification.
- Both catalogs passed browser checks at 390 and 1280 pixels; the Melodica catalog contains only its browser extension and keeps the player bar pinned.
- The Worker release manifests were updated in R2; all other Melodica projects were preserved. No player or Worker code was deployed by this publication.
- Evidence: https://github.com/Spaceghost/melodica-extension/actions/runs/42621298090.
<!-- extension-publication:end -->

Updated 2026-11-09. Self-hosted 0.8.8 published and verified; automatic CI rollout in validation.

## Full release cycle checkpoint

- 0.8.8 is now live in both R2 manifests, both browser update feeds, `/extensions/#melodica-extension` and `/melodica/extension/`. Eight public package downloads match GitHub SHA256SUMS; browser checks passed at 390 and 1280 pixels with the player pinned and no page errors or horizontal overflow. All 11 other Melodica projects were preserved. Evidence: `~/workspaces/crew-e2e-fedora/extension-sites-0.8.8-live.json` and `extension-pages-0.8.8/report.json`.
- Mozilla unlisted signing is preserved. The signed XPI was installed permanently in normal Firefox 154.0 with signatures required and stayed active after a browser restart; its report is a published 0.8.8 asset. No public Mozilla listing was created.
- `publish.yml` and `scripts/release/` implement automatic post-CI publication, late iOS resync, scheduled catch-up, batched uploads, cached downloads, public verification, handoff updates and the public app snapshot. See docs/RELEASING.md. Local regression tests: 29 passed. A real 0.8.8 dry run validated all 133 mirrored files and needed zero asset uploads. Live CI repair validation is next.

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

- Native Rooms 0.9.1 candidate on `wip/fedora-engine-handoff` adds a full-tab
  extension Rooms view and native background/offscreen room ownership. Room
  controls route through the extension-owned shared session; the player view
  exposes sanitized room playback and locks private controls during an active
  DJ turn. Search/recent, room API, clock forwarding, account sign-out cleanup,
  bounded public snapshots and per-device room publisher identity are wired
  through the extension bridge. Each install keeps a non-secret stable room
  device ID; the server snapshot distinguishes the local publisher from other
  devices using the same account. The pinned shared UI/media assets are the
  live `f72faab991631971` bundle (commit
  `95135d10591a66eae05ca3c3af86c46963f0cc5f`), verified against the immutable
  public manifest and asset digests. The full unit suite passed 56/56 and the
  0.9.1 extension build succeeded with this pin.
  A focused Chromium test against the local tuner and synthetic room API
  exercised join, listening audio, page unmount, scrobble opt-out, search and
  zero Pandora JSON/media refetches on the previous media pin. The initial
  worker-stop/restart proof exposed an Imba compile bug in `restoreRoomSession`
  (`async is not defined`); the async closure is fixed, but recovery has not been
  rechecked in Chromium. A focused run against the 0.9.1 pin is pending. SFU
  media transport is not claimed browser-verified. The 0.9.0 release is live;
  its package/build and catalog/download checks passed, but full browser proof
  remains pending after the Chromium/Brave username options assertion and the
  Firefox diagnostics selector failed.

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
