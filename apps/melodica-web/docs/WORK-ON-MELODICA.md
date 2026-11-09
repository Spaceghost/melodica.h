# Work on melodica: agent prompt

Paste everything below the line into Claude Code or Codex to start or resume melodica work on any host (alienware, fedora, bak). Add the task at the end, or leave it blank to work the queue.

---

You are working on **melodica**, Jack's Pandora client family, all served under https://spacegho.st/melodica/. Work autonomously: Jack is often away and dislikes questions, so pick sensible defaults, keep shipping, and report outcomes. If you need Jack and he is away, leave the question in tmux session `atlas-questions` on bak and keep working on something else.

## 1. Get oriented (every session)

1. Clone or update every repo under ~/Projects (GitHub owner Spaceghost; `gh` is logged in):
   `for r in melodica-web melodica-extension melodica-scrobble spaceghost-auth extensions-site melodica-tuner; do [ -d ~/Projects/$r ] && git -C ~/Projects/$r fetch --all -q || gh repo clone Spaceghost/$r ~/Projects/$r; done`
   Clone melodica.h to ~/workspaces/melodica.h.
2. Read **HANDOFF.md** at the root of each repo's default branch and of any `wip/*` branch. HANDOFF.md is the authoritative state: what is live, what is in progress (branch, commit, next command), the queue, open CI runs and background jobs. For forked apps, read melodica.h/apps/HANDOFF-scrobbling.md.
3. Read the docs before changing their area:
   - melodica-web: docs/BRIDGE.md (page/extension bridge), docs/ACCOUNT.md
   - melodica-scrobble: docs/GAMES.md (Conquest), docs/ROOMS.md (DJ/rooms), docs/LISTEN-URI.md (listen://)
4. Check Cloudflare access with `npx -y wrangler@4.135.0 whoami`. If you are not logged in, skip deploys and tell Jack to run `npx -y wrangler@4.135.0 login` on that host.
5. Other agents may be working. Before pushing to a branch, `git fetch` and check the newest commit's author and time. If it was pushed within ~15 minutes, wait and re-check. Never work in a checkout that has someone else's uncommitted changes; use `git worktree add` instead.

## 2. The repos

| Repo | What |
|---|---|
| melodica-web | The web player and the /melodica/ site Worker (`site/`: Pandora relay, GitHub OAuth bridge, single-page app shell, `scripts/sync.mjs`). Release by tagging `v*`. |
| melodica-extension | MV3 extension for Chrome, Brave, Edge and Firefox, plus an iOS Safari sideload. Imba UI and a Nelua→wasm core. Release by tagging `v*`; update feeds live on spacegho.st/extensions. |
| melodica-scrobble | The scrobble service: the ListenBrainz-compatible API at /scrobble/1/*, the listens/leaderboard JSON and live channel, the album-art cache (R2 `melodica-art`), the Conquest game, and the shared `ui/` bundle the clients vendor by pinned hash. |
| spaceghost-auth | spacegho.st/oauth: accounts, allow-list, invites, admin page and crew rules. |
| extensions-site | The spacegho.st/extensions store and its update feeds. |
| melodica-tuner | Pandora test server used by the client CI smokes. |
| melodica.h | A **public** repo. `apps/` holds snapshots of the client apps (`apps/pull.sh <dir>`) and the forked apps (`apps/apps.tsv`). Never put private code or the shared ui bundle in it. |

Retired: melodica-site, which is folded into melodica-web/site; never deploy from it. **ghostty-vote is not part of melodica.** Never touch it.

## 3. How to work

- **Builds and tests** run only in Incus containers or CI, never on a host directly:
  - bak: melodica-ext, spaceghost-auth, and gh-runners (the self-hosted CI runner);
  - fedora: melodica-dotnet, melodica-clients, melodica-mobile.
  Wrangler deploys and D1 commands may run from the host.
- **Publish as soon as green.** Don't batch. Tag `v*`, deploy the Worker, then run `node scripts/sync.mjs <project>` from melodica-web/site, then `apps/pull.sh <dir>` in melodica.h.
- Pushing directly to the default branch is fine. Never change a repo's visibility, and never publish to a browser store.
- **Shared ui bundle:**
  - after any scrobble `ui/` change, bump the pin in the clients (`scripts/bump-scrobble-ui.sh` or `fetch-scrobble-ui.sh`);
  - CI's `check-ui-pin.mjs` fails on drift;
  - GitHub-hosted runners can't fetch spacegho.st assets, so that step runs on the bak runner.
- **Keep HANDOFF.md current** after every release or stopping point: what is live, which branch and commit, the next command, the queue. Push work in progress to a `wip/*` branch so another agent can resume after a usage limit.

## 4. Product rules (locked by Jack)

- The site is one continuous single-page app. The player bar is pinned to the bottom of the viewport on every /melodica/ route and never stops when you navigate.
- It behaves the same whether or not the extension is installed:
  - the page detects the extension without opening its popup;
  - a reload restores the last state immediately and never lands on the login card.
- **Tabs and devices:**
  - Exactly one tab plays; the others are remotes.
  - Play after a pause resumes in the tab that last played.
  - Handing off between tabs makes zero Pandora, relay or account requests; tabs share state through localStorage, BroadcastChannel and Web Locks.
  - Each device resumes its own last song, and only the device actually playing caches that song's audio.
- **Conquest:**
  - The player is the engine of game state change; there are no manual game buttons.
  - Listens deploy units. Thumbs up fortifies the current town. Thumbs down retreats units along the supply line (or to reserve) and closes that town to the listener for the season, unless they later thumb it up.
  - Selecting territory shows plainly what to listen to, with ▶ Play.
  - Seasons alternate Overlord and Crusade.
  - The Spaceghost handicap stands.
  - The player-tab map and /melodica/map/ are the same component with the same live data.
  - Full rules are in melodica-scrobble docs/GAMES.md.
- **Crew pages:** only Spaceghost and the GitHub accounts he follows, after a real Sign in with GitHub at spacegho.st/oauth, may view them. Followers-only accounts appear on crew pages but can't view them.
- **Rooms and DJ mode:** Jack has Pandora's approval to stream what he plays to listeners. Add no ToS caveats.
- The `plus` boolean is described only as "the playback flag the client follows". Never describe what it changes, in any doc, UI text, comment, test name, commit message or release note. Pandora API identifiers the client must send may stay.
- **Never put a colored border or stripe on a single side of a rounded card.** Use a full border, a tint or a badge. `scripts/lint-edges.mjs` enforces this.
- Album art goes through the scrobble art cache with a fallback (`cover(src, cls, cached)`). Send art URLs exactly as Pandora gives them; http is fine.

## 5. Data and secrets

- Store user emails server-side only (D1 and the admin list). Never show them in clients, and never tell users they are stored.
- Never store or log Pandora passwords.
- Delete every test user or account you create once its test is done.
- Keep secrets out of repos, logs and history. Pipe secrets straight into `wrangler secret put`.
- Back up D1 to bak before any migration. Back up before any overwrite or delete on bak, and never delete backups.
- History rewrites and force-pushes need Jack's explicit approval for that specific rewrite.

## 6. Evidence and reporting

- Report only what you observed on the exact artifact: the deployed version, the tagged release, the live URL. Static checks and unit tests prove only what they run. Say plainly what is unverified.
- Verify user-facing changes on production at phone width (Pixel 7) and at 1280 px.
- For Jack, who has ADHD:
  - lead with the result;
  - use numbered steps and lists of five items or fewer, with no preamble;
  - restate the current state every time.
  - When an item is finished, send one line: what is live (version), how it was verified, and what is unverified.
- Commit trailer: use your tool's attribution, e.g. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 7. Task

<!-- Put the task here. If empty: work the queues in each repo's HANDOFF.md, highest priority first. -->
