# Handoff (melodica-extension)

Updated 2026-11-09 for 0.8.5. Rewrite this after every release.

## Live

| Version | Commit | What |
| --- | --- | --- |
| 0.8.5 | 288c0eb | Scrobbles: only 403 `scrobbling_off` turns scrobbling off. The queue is kept, flushed at start and every 60 s. The popup shows a failure line. `play-seed`/`seed` bridge command. Listens carry station_name and submission_client_version. No single-side accents, linted by scripts/lint-edges.mjs. |
| 0.8.4 | 9c4f9dc | Resume of the last song on this device (sealed record, audio copy). Sign in with GitHub. Album art as Pandora gives it. |
| 0.8.3 | 4ff3106 | Thumbs to Conquest (crew), genome traits on listens, terrain stations. |

Each release has 55 assets. The extensions feeds (spacegho.st/extensions) and the melodica site carry it, and melodica.h has the snapshot (apps/pull.sh).

## In progress: 0.8.6 on branch `wip/0.8.6`

- listen:// links (melodica-scrobble docs/LISTEN-URI.md, parser in src/listen-uri.js):
  - player.html?listen= prompt (never autoplays);
  - content script on spacegho.st/listen/*;
  - omnibox keyword `listen`;
  - Firefox `web+listen` protocol_handlers (scripts/build.mjs);
  - iOS `listen://` (Info.plist, SceneDelegate);
  - "Copy listen link" in the popup and player tab.
- `queue` (Up next) in the bridge state and the player tab.
- A live e2e test: `test('live: …')` in tests/smoke-extension.spec.mjs, run by tests/live-e2e.sh.
  - It forwards /scrobble/ to the real spacegho.st with a throwaway token.
  - The token file lives outside the repo and never goes in the repo.

Next steps:
1. Run the smoke on bak:
   `GH=/home/linuxbrew/.linuxbrew/bin/gh scripts/remote-sync.sh 'export PATH=$HOME/.local/bin:/usr/local/bin:$PATH; npm run build; xvfb-run -a npx playwright test'`
2. Merge to master and wait for CI to go green on the full SHA.
3. Tag `v0.8.6` and wait for ci and ios (55 assets).
4. Sync extensions-site and the melodica site (melodica-web `site/scripts/sync.mjs melodica-extension`).
5. Run apps/pull.sh.
6. Tell the web agent that `queue` is live.

## Queue after 0.8.6

1. Live e2e in Chrome, Brave and Firefox. The test account `u_e2eext00001` is owned by the scrobble agent: ask it to delete the account afterwards, and do not delete it yourself.
   - The live login cannot pass access without Jack adding an allow-list entry, so the test fakes /oauth/ and keeps /scrobble/ live.
   - Crew views, real GitHub sign-in and Firefox audio on bak are not provable there.
2. Pending contracts, not yet in melodica-scrobble docs/CLIENTS.md: the deployment chip/toast/popup line, and the shared ui `cover()` in the popup and player.
3. The history rewrite (ad scrub) was already done on 2026-11-08. Bundles are on bak:~/history-rewrite-2026-11-08/. Nothing remains.

## Rules

- Never build or run on the workstation. Use the bak Incus container `melodica-ext` through scripts/remote-sync.sh.
- Kill tuners before a smoke: `ssh bak "incus exec melodica-ext -- sh -c 'pkill -f [m]elodica-tuner; true'"`.
- Run one smoke at a time.
- GitHub Actions is the proof. Report only what was observed.
