# Executable CI and the native-language chase

Hosted checks at `a24657a4a0b7c3b1244e00636b456cfa8a912ec2` ended before runner setup. The connector cannot read their diagnostic annotation endpoint, so a billing/quota cause is not asserted. The existing Atlas self-hosted route had a separate concrete gap: `Spaceghost/melodica.h` was not in its repository-scoped allowlist.

PR workflows now request `[self-hosted, Linux, X64, ubuntu-tiny, spaceghost-melodica.h]`. The PR event creates the jobs; no helper rewrites or manually dispatches workflow definitions. A manual `runner=github-hosted` dispatch remains available after the hosted problem is actually resolved. Foreign-fork PR code is not automatically admitted to the self-hosted pool.

On `bak`, `python3 scripts/ci-on-bak.py --apply` diagnoses Actions with the existing authenticated `gh`, then stages hash-verified ordinary runner helpers from `Spaceghost/atlas-infra` commit `e53704e06f62e47ea60b27a56fee0f406f518c1a`. Its private allowlist contains only this repository. Existing Atlas allowlists/services are not edited. It auto-selects only an existing ordinary project containing stateless `runner-ubuntu-base/sealed-v2.336.0`, audits the base, rejects privileged/nested/raw configurations, host mounts, device passthrough and non-`sandbox0` networking, and starts one replenished ephemeral Incus slot. No HIL project, USB device, Docker, OpenRC install, host package install, cloud account, billing setting or repository visibility is touched. Host authentication remains in the broker, never the image.

## Pool startup and failure evidence

The reported `bak` startup reached `credential-free runner base verified`, then failed at `tmux set-option` with `no such session`. That local transcript proves the audit completed and the expected session was unavailable at tagging time. It does not identify why the initial pool command/session exited. The previous launcher depended on the interactive tmux server's configuration, invoked one shell-command string, and only tagged ownership in a subsequent call. An immediate exit could erase the session before the tag was set.

The launcher now uses a **dedicated tmux server**, `-L melodica-ci-v2`, with its own config at `$XDG_STATE_HOME/melodica-ci/tmux.conf` (default `~/.local/state/melodica-ci/tmux.conf`). Before the child runs, that config establishes ownership, `/bin/sh`, `remain-on-exit on`, and non-attached operation. `/bin/sh` and the entry-file path are passed as separate arguments, bypassing the interactive default shell. There is no post-spawn ownership-tagging call.

`pool.log` is opened before tmux is invoked; shell stdout/stderr append to it. Stable session/pane IDs and the bundle/project are saved in `pool-session.json`. An immediate process exit is reported with its status, log tail, and captured terminal output (`pool-pane.txt`), while the dead pane remains inspectable. A dead pane is **not** reported as a running pool and is not automatically respawned. A surviving pool process is not proof of GitHub registration or job pickup.

Inspect the new private server without modifying ordinary interactive sessions:

```sh
tmux -L melodica-ci-v2 list-panes -t '=melodica-ci' -F 'pane=#{pane_id} dead=#{pane_dead} status=#{pane_dead_status}'
tail -n 80 "${XDG_STATE_HOME:-$HOME/.local/state}/melodica-ci/pool.log"
```

A running owned pool on the legacy default server is preserved, not duplicated. An unowned or ambiguous server/session is left untouched. After inspecting an exited pool and reconciling any leftover worker/registration, remove only its private session with `tmux -L melodica-ci-v2 kill-session -t '=melodica-ci'` before reapplying. Do not kill the default tmux server. The existing pinned runner's exact-worker cleanup and crash-recovery limits are unchanged.

Without `--apply`, the command prints and records runner/job/annotation diagnostics under `~/.local/state/melodica-ci/diagnosis.json` (or `$XDG_STATE_HOME`). Apply mode retains the same JSON but prints its path rather than repeating cancelled-run records. Missing snapshots, permissions, network reachability or runner-version problems must be repaired explicitly rather than bypassing the audit.

`tests/test_ci_pool.py` covers startup orchestration and executes the POSIX entry script's error/exit handling. It also includes real tmux integration tests for immediate exit and custom-shell/config isolation; those tests skip only when tmux is absent. CI installs tmux **inside the Ubuntu job worker**, not on bak, and discovers `test_ci*.py` so both suites run. No live bak activation is asserted by these tests.

## Native and upstream gates

`python3 scripts/native-ci.py` rebuilds the real C, Odin, Zig, Nelua and Codin C99 artifacts using the existing flags; each lane gets its existing smoke test plus the same independent `tests/conformance.c`. Failed lanes do not prevent attempts of the remaining languages, but any failed lane/control withholds rankings. Native Codin is still an Odin control, not a sixth contender. The shared conformance test checks all seven ABI functions, every byte value, embedded NULs, exact/undersized buffers, guards, source immutability, null pointers, decimal boundaries and seeded random inputs.

Only after correctness succeeds does the unchanged five-workload benchmark execute serially. The scoreboard rejects missing/duplicate metrics, wrong units, zero/non-finite values and nonzero benchmark exits, and removes stale rankings before every attempt. `make shootout-gate` remains >=90% normalized geometric mean and >=80% worst workload. Evidence retains source hashes, CPU/compiler details, per-lane build/test logs, archive hashes/bytes, section/symbol reports and dynamic dependencies. A C artifact is never used as evidence for another language.

The pinned unmodified libpiano differential remains a separate C compatibility league. Real pianobar source compilation uses `tests/reference/pianobar.rev` rather than moving `master`. GET_STATIONS result-shape semantics were corrected in `d826b986e4a91539710acdae8b72447cf203a089`; completed upstream execution and any resulting failures still precede protocol expansion in the other languages.

No new speedup, size movement or compatibility pass is claimed by this startup repair. See `docs/evidence/tmux-pool-local-2026-09-14.txt` for exactly which tests executed locally.
