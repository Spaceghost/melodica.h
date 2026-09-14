# Executable CI and the native-language chase

## What failed

At `a24657a4a0b7c3b1244e00636b456cfa8a912ec2`, hosted checks ended before
runner setup. Each check has a diagnostic annotation, but this conversation's
GitHub connector cannot read the annotation endpoint. A billing or quota cause
has **not** been established. Repeatedly rerunning the same job does not fix it.

The self-hosted route has a separate, concrete admission gap: the reviewed
`Spaceghost/atlas-infra` allowlist does not contain `Spaceghost/melodica.h`.
Personal-account listeners register to individual repositories; Atlas listeners
cannot take Melodica jobs merely because generic Linux/X64 labels overlap.

## Start the existing Incus route on bak

From this checkout, on the existing controller with authenticated `gh`, Python 3,
`incus`, `tmux` and `sh`:

```sh
python3 scripts/ci-on-bak.py --apply
```

Without `--apply`, the command only records diagnostics. It reads runner inventory,
job assignments and check annotations through the operator's existing GitHub CLI.
The report is retained under `~/.local/state/melodica-ci/diagnosis.json` (or
`$XDG_STATE_HOME/melodica-ci`). Permission errors are not reported as empty lists.

Apply mode stages hash-verified, unchanged ordinary runner helpers from
`Spaceghost/atlas-infra` commit `e53704e06f62e47ea60b27a56fee0f406f518c1a`.
Its private bundle has an allowlist containing **only this repository**. Existing
Atlas allowlists and pools are not edited. The broker uses a dedicated owned
`melodica-ci` tmux session, one replenished ephemeral job slot, and the existing
stateless `runner-ubuntu-base/sealed-v2.336.0` snapshot. Jobs execute inside Incus;
there is no host build service, OpenRC installation, Docker, new cloud account,
billing change or repository visibility change.

The command auto-selects the snapshot only when it exists in exactly one ordinary
project (`codex-workers`, `atlas-workers` or `runners`). Use `--project` to resolve
an actual ambiguity. It never creates/replaces the base. It rejects privileged
or nested containers, raw overrides, non-root mounts, device passthrough and NICs
outside `sandbox0`; the root disk must use the existing `bak` pool. It executes
the pinned credential-free base audit before requesting runner registration.
No HIL/controller project or USB device is admitted. Existing host authentication
stays in the broker, not in the worker image.

A started tmux session is not evidence of a registered listener or successful CI.
Inspect `pool.log` in the same state directory and actual Actions jobs. A missing
snapshot, expired/unsupported pinned runner, network failure or missing permission
must be repaired explicitly, not bypassed by relaxing the audit. This activation
has not been executed on bak from the conversation environment.

Both workflows now default to the repository-scoped labels:

```yaml
runs-on: [self-hosted, Linux, X64, ubuntu-tiny, spaceghost-melodica.h]
```

Manual dispatch can select `runner=github-hosted` after the actual hosted problem
is resolved. Automatic foreign-fork PR code is not admitted to the self-hosted
pool; review it before any trusted manual dispatch. Checkout does not persist
credentials. Superseded runs are cancelled, jobs have bounded timeouts, and
failed jobs retain available evidence. Stop only the owned pool with
`tmux kill-session -t '=melodica-ci'`; the pinned launcher attempts its normal
exact-worker cleanup. No stronger crash-recovery guarantee is claimed.

## All native lanes, not C approximations

`python3 scripts/native-ci.py` rebuilds the real independent C, Odin, Zig, Nelua
and Codin C99 artifacts with the existing Makefile flags, runs existing smoke
checks, links the same `tests/conformance.c` to each library, and executes it.
A failed language does not prevent attempts of the other languages. Native Codin
remains an Odin control, not an extra contender. No fallback implementation or
system compiler version is silently substituted for a failed pinned toolchain.

The shared conformance test covers all seven ABI functions, every byte value,
embedded NULs, unaligned buffers, exact and undersized capacities, guards,
source immutability, null pointers, decimal boundaries and seeded random inputs.
It is an additional test, not a replacement for the existing tests.

Only after all native/control checks pass does the unchanged five-workload
benchmark execute serially on the same worker. The scoreboard requires every
lane, every workload exactly once, correct units, positive finite measurements,
and a successful process exit. A crashing executable cannot be hidden by `tee`.
Old scores are removed before a new attempt. The existing `make shootout-gate`
thresholds remain 90% normalized geometric mean and 80% worst workload; ordinary
standings remain informational until explicitly gated.

Evidence includes source hashes, exact compiler/CPU identity, build/test output,
archive hashes/bytes, object-section sizes, symbols and dynamic dependencies.
Codin's generated object is also wrapped in a fresh archive for archive-to-archive
reporting. Raw archive size includes toolchain metadata; it is not resident memory
or deployed dependency size. Runtime libraries remain visible in `ldd` output.

## Upstream compatibility is a separate gate

The pinned, unmodified upstream differential, playlist allocation tests, wire
oracle and sanitizers are retained. Real pianobar source compilation now uses
that same reference pin rather than moving `master`. The full `piano.h` league
is still C-only and separate from the native serializer scoreboard. The outstanding
GET_STATIONS result-shape mismatch and any newly executed differential failures
come before expanding protocol implementations in the other languages.

No new language speedup or full-upstream compatibility result is claimed by this
CI repair. See `docs/evidence/ci-local-2026-09-14.txt` for executed local checks.
