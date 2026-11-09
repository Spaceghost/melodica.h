# HANDOFF (melodica-web)

Updated 2026-11-09 PT (0.11.2 live). Keep this current after every release.

## Fedora continuation

- Next prepared player release is 0.11.3: preserve the first painted song, prepare the sealed last-song record before controls become ready, broader crew coverage, browser-only extension page, and verified UI pin automation. All runtime/site files are unchanged from c3a9d7d, whose build/UI-pin CI and full browser CI passed (42578308301, 42578311466; the extension job passed on rerun). The later merge adds current docs and the other host's hello-order test correction.
- The exact c3a9d7d CI dist with released extension 0.8.7 was also tested on Fedora. Forty normal reloads passed; one of three cold starts took about 6.2 seconds to return restored state. This remains an extension-startup concern, not a claim of a universally fast cold start. Evidence: `~/workspaces/crew-e2e-fedora/real-extension-fedora.log`. Keep investigating it; do not loosen the timing limits.
- The next artwork/queue work is separate in `~/Projects/melodica-web-up-next`, branch `wip/fedora-up-next`. It shows title/artist/album/covers from bridge queue data and uses the shared cover helper for the player, bar, history and queue. Focused artwork checks passed with HTTP source hashes and no CSP errors. Full regression validation is still in progress; do not include it in 0.11.3.

- Jack explicitly authorized compiling and testing on Fedora. Emscripten 3.1.74 is at `~/workspaces/melodica-emsdk-fedora`. The integrated worktree is `~/Projects/melodica-web-immediacy`, branch `wip/fedora-immediacy`.
- Production 0.11.1 was verified from Fedora with the existing crew-test session and anonymously at Pixel 7 and 1280: rendered territory paths, visible Map navigation, no stale notice, no invalid text, and the GitHub sign-in button for anonymous visitors. These checks used the deployed assets without substitution. Evidence: `~/workspaces/crew-e2e-fedora/production-0.11.1/`. Test-identity cleanup remains pending; Fedora Wrangler is unauthenticated.
- The integrated branch includes the latest other-host startup work through 318cbc4, the Fedora reload fix, broader crew tests, the extension-page correction, and UI pin automation. Another host is actively updating `wip/immediacy`; fetch and preserve its work. Never force-push.
- Startup: the original code reproduced alternating ~5,090 ms reloads. Pending background validation could discard the snapshot during navigation, and initialization immediately replaced the painted song with the idle view. The fix keeps the song/snapshot during restoration and does not clear it as the document leaves. The timing test checks every reload and its first displayed song, not just a median.
- Quick restore now decrypts the local last-song record before declaring the controls ready; account/network validation continues in the background. Immediate Play resumes that record with no new playlist request. The stronger focused check passed all ten reloads (visible 4–14 ms, interactive 14–75 ms) after the station-name integration; log: `~/workspaces/crew-e2e-fedora/immediacy-resume.log`.
- Fedora validation before the latest station-name integration: all 49 playback/remote browser tests, five client unit suites and build/static checks passed. All ten standalone reloads were visible in 4–21 ms and interactive in 17–67 ms with 250 ms fixture network delays. Remote timing passed too. Logs: `~/workspaces/crew-e2e-fedora/immediacy-{browser,fixed,remote}.log`. Recheck unit tests and CI after integration.
- Extension page: `/melodica/extension/` now selects only `melodica-extension`; `https://spacegho.st/extensions/` links to the full store. The change from `wip/fedora-extension-page` is merged here. Its 28 site tests, packaging dry run, 390/1280 candidate checks and site CI 42575956744 passed. It is not deployed.
- UI pin freshness runs on bak and fails when it cannot verify the manifest. The hourly `shared UI pin` workflow verifies both asset digests and the combined hash, waits until master has been quiet for 15 minutes, pushes without rewriting history, and explicitly dispatches CI/browser validation. The updater passed against the live manifest and rejected a corrupt digest while preserving the existing pin. These workflow changes still need CI on this branch.
- Build: `EMSDK=$HOME/workspaces/melodica-emsdk-fedora MELODICA_WEB_VERSION=0.11.2 scripts/build.sh && scripts/check.sh`.
- Publication and remote cleanup require `npx -y wrangler@4.135.0 login` on Fedora. Deploy only from this repo's `site/`; sync the release, verify production, then refresh `melodica.h` with `apps/pull.sh melodica-web`. Honor the 15-minute check before pushing to an active branch.

## Live
- **melodica-web 0.11.2**, tag v0.11.2; R2 VERSION 0.11.2; site Worker 672fc27a (deploy only from melodica-web/site; ~/Projects/melodica-site is the old repo with the same Worker name).
  - Reloads restore from the snapshot (first paint 4-58 ms measured on bak; 0.11.0 took about 5.1 s). The cause was an aborted refresh on page leave deleting the snapshot.
  - additional_info.station_name is sent with every listen and playing_now; never the track token.
  - 0.11.1 (before it): the map works for every crew member, with visible Sign in with GitHub notices.
  - Shared UI at content hash 5d0e0d0e.
- The scrobble Worker 301s /scrobble/<page>/ to /melodica/<page>/.
- melodica-extension 0.8.6 is live, with bridge `queue` [{title, artist, album, coverArt, art, duration, trackToken}].

## In progress
1. (0.11.1 shipped.)
2. (0.11.2 shipped.)

## Queue (in order)
1. CI: the ui pin check gets 403 from GitHub runners, even with curl; move that step to the bak self-hosted runner. Also add an auto-bump job that follows latest.json.
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
7. Reply to the coordinator. The player sends art_url, http included. Station name and track token are NOT in the CLIENTS.md contract, and the README says they are not sent.
8. Last: the history rewrite of melodica-web, melodica-site and melodica.h, after fresh backups (force-push allowed only for this). Add `history-redacted@example.invalid` (in 649fe36, site/tests/relay.test.mjs) to --replace-text. Delete test users.

## CI and jobs
- Browser CI on master 0e8cb0f, run 42570048843: smoke and local-dist succeeded, hosted skipped, extension-real was queued at last check. Re-check: `gh run view 42570048843`.
- bak Incus containers (always `--project default`):
  - melodica-emsdk builds;
  - melodica-browser runs the Playwright tests (/work/melodica-web, tuner at /work/melodica-tuner; the 0.11.0 dist is at /work/mw0110/dist);
  - melodica-ext belongs to the extension agent.
- Poll CI with `gh run watch <id> --interval 120`.

## Rules
- Direct pushes. Never force-push, except for the final history rewrite. Never change repository visibility.
- Fedora compilation and testing are authorized by Jack; deploy the Worker from Fedora after login.
- Keep policy details out of UI copy. Store no emails. Report only what was observed.

- melodica-scrobble moved to Spaceghost/spaceghost-scrobble.
- Two tuner insert tests (smoke-playback 281 and 1280) fail on bak even on 0.11.0; investigate.
