# HANDOFF (melodica-web)

Updated 2026-11-08 23:05 PT. Keep this current after every release.

## Live
- **melodica-web 0.11.1**, tag v0.11.1 at bbb3688; R2 VERSION is 0.11.1; site Worker version 7e2086f1, deployed from melodica-web/site.
  - The map works for every crew member. Panels mount with the scrobble cookie; failures show visible notices with Sign in with GitHub; a silent prompt=none runs on panel routes.
  - Shared UI is at content hash 5d0e0d0e.
  - Deploy only from melodica-web/site. ~/Projects/melodica-site is the old repo, and the Worker name is the same: deploying from it reverts the shell.
- The scrobble Worker 301s /scrobble/<page>/ to /melodica/<page>/.
- melodica-extension 0.8.6 is live, with bridge `queue` [{title, artist, album, coverArt, art, duration, trackToken}].

## In progress
1. (0.11.1 shipped.)
2. **`wip/immediacy`** (96d9eb1, branched from 0e8cb0f; also kept in `git stash` "0.11.2 immediacy"). It becomes 0.11.2 and contains:
   - snapshot paint, quickResume, markReady/whenReady, the remote connecting dot;
   - first-paint budget tests;
   - the .pull and kbd lint fixes.

   Rebase it onto 0.11.1. A hosted-like measurement (no ?api) found 0.11.0 at about 5.1 s to visible. 0.11.2 is fast in some runs but still hits about 5.1 s in others: find that roughly 5 s wait before shipping. The CI budgets are visible under 100 ms and interactive under 300 ms after DOMContentLoaded.

## Queue (in order)
1. CI: the ui pin check gets 403 from GitHub runners, even with curl; move that step to the bak self-hosted runner. Also add an auto-bump job that follows latest.json.
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
