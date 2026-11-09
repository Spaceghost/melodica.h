# HANDOFF (melodica-web)

Updated 2026-11-08 22:20 PT. Keep this current after every release.

## Live
- **melodica-web 0.11.0**: R2 `VERSION` 0.11.0; site Worker version 32a4a650. Every route serves the app shell: /melodica/, app/, listens/, leaderboard/, map/, account/, extension/.
- The scrobble Worker 301s /scrobble/<page>/ to /melodica/<page>/.
- melodica-extension 0.8.5 is live (the seed/play-seed command). 0.8.6 (bridge `queue`) is in smoke.
- **Known bug in 0.11.0:** crew members who signed in only with GitHub cannot see the map (knewter). The panels never mount without a player token, and the Map nav link stays hidden. Being fixed in 0.11.1.

## In progress
1. **`wip/map-fix`** (c62e963, on top of master 0e8cb0f). It becomes 0.11.1 and contains master's c46daf2, 816d75d and 0e8cb0f plus:
   - The panels mount with the `__Secure-scrobble` cookie when there is no token.
   - Visible notices: "Sign in with GitHub to see the crew map" links to /scrobble/auth/start?next=<route>; crew_only shows the invite-only text; a Try again button.
   - The panels remount when sign-in changes.
   - A silent prompt=none sign-in on panel routes, once per session, returning to the route (RETURN_KEY).
   - The Map link is hidden only when we know the visitor is not crew.
   - scrobble-ui pin moved to 8f00544 (js ae8a5018…). The 0.11.0 vendor copy is stale.
   - A Pixel 7 412-wide test, "the map on a phone", in tests/smoke-playback.spec.mjs.

   Next commands, in order:
   1. Build: `cd ~/Projects/melodica-web && MELODICA_WEB_VERSION=0.11.1 scripts/remote-build.sh`. It builds in bak melodica-emsdk; never build on the workstation.
   2. Copy to the test container: `tar czf - dist tests/*.mjs tests/tools site/src | ssh bak "incus --project default exec melodica-browser -- sh -c 'tar xzf - -C /work/melodica-web'"`.
   3. Run the tests: `ssh bak "incus --project default exec melodica-browser -- sh -c 'cd /work/melodica-web && MELODICA_TUNER_DIR=/work/melodica-tuner npx playwright test tests/smoke-playback.spec.mjs tests/remote.spec.mjs'"`. If something already listens on port 8443 there, kill that orphan tuner first.
   4. Merge to master, push, then `git tag v0.11.1 && git push origin v0.11.1` (release.yml).
   5. Publish: `cd site && source ~/.local/bin/agent-storage-env melodica-site && node scripts/sync.mjs melodica-web && npx wrangler deploy`.
   6. Verify live: `curl -s https://spacegho.st/melodica/app/VERSION`, then compare the sha256 of /melodica/app/vendor/scrobble-ui/scrobble-ui.js with /scrobble/assets/ui/<pin>/SHA256SUMS.
   7. Snapshot: `cd ~/workspaces/melodica-apps-2026-11-07/melodica.h && git pull --ff-only && apps/pull.sh melodica-web && git push`.
   8. Send the deploy id to the scrobble agent (abf5584ee948676a0). It re-runs its prod e2e with the test user u_crewe2etest01 and deletes that user afterwards.
2. **`wip/immediacy`** (96d9eb1, branched from 0e8cb0f; also kept in `git stash` "0.11.2 immediacy"). It becomes 0.11.2 and contains:
   - snapshot paint, quickResume, markReady/whenReady, the remote connecting dot;
   - first-paint budget tests;
   - the .pull and kbd lint fixes.

   Rebase it onto 0.11.1. A hosted-like measurement (no ?api) found 0.11.0 at about 5.1 s to visible. 0.11.2 is fast in some runs but still hits about 5.1 s in others: find that roughly 5 s wait before shipping. The CI budgets are visible under 100 ms and interactive under 300 ms after DOMContentLoaded.

## Queue (in order)
1. 0.11.1 map fix (above).
2. 0.11.2 immediacy.
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
- Never build or run melodica-web on the workstation; deploying the Worker from here is fine.
- Keep policy details out of UI copy. Store no emails. Report only what was observed.
