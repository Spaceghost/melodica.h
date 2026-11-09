# Handoff (melodica-extension)

Updated 2026-11-09 for 0.8.5. Rewrite this after every release.

## Fedora extension integration candidate

- Branch `wip/fedora-extension-integration` in `~/Projects/melodica-extension-integration` combines transfer/copy commits 28109d6 and 3d9a428 with current master e0851c4. Merged to master and tagged v0.8.8 after CI 42591268373 passed build, Chromium, Brave and Firefox. Release run 42593828496 passed build and Chromium/Brave/Firefox, then failed publication because the self-hosted release job had no Node. The exact tagged artifacts and all three proof reports were downloaded; the unchanged tag release-proof script passed locally and every checksum verified. GitHub v0.8.8 was then published with 61 assets from those artifacts. iOS run 42593828451 passed web and simulator jobs; attachment is queued. Feed sync is pending. No Worker/R2 deployment from Fedora. User explicitly permits Fedora builds/tests, overriding older workstation restrictions below.
- Private engine transfer and bounded cached-audio copying are unchanged from the tested handoff branch. CI now runs the seven transfer/copy unit cases, installs Chromium system libraries on self-hosted runners, and requires successful UI freshness verification. Generated release access text now reflects Pandora sign-in and optional spacegho.st sign-in.
- Shared UI pin bumped to the latest PUBLIC content hash 7b2e55dadefebdee. Service replay fix e0c05db1178ede82 is merged but not deployed; bump again after it is published. Do not claim that unpublished pin is served.
- Local 0.8.8 candidate builds with the verified released 0.8.7 core (14961 bytes); `git diff 5b22d59 HEAD -- core` is empty. CI rebuilt the core from its pinned toolchain; both CI browser builds match the local/released binary SHA-256 09b736044c6ba0bf7ede2ccdd448e952a0b685883f7e29bbb574176ba44ee0a5. Core vectors (30), account (37), scrobble (50), update (44), parser (3) and transfer/copy (7) checks passed.
- The combined web/real-extension suite passed all six with local candidate df2f438 after web startup corrections. Web alone passed all 69 checks. A separate full native run is now checking the exact tagged Chrome ZIP (`combined-extension-tagged-0.8.8.log`); its JS bundles differ from the local build, so the local six-test result is not exact-package proof. Next: inspect release CI, verify the published artifact, sync feeds and recheck the deployed artifact. Keep the original timing/ownership assertions. Main-branch/Worker publication and browser-store publication are distinct; never publish to stores. Cloudflare work on Fedora remains dependent on `npx -y wrangler@4.135.0 login`.

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
