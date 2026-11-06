# Build, validation and CI

Run the complete default-build validation with:

```sh
make check
```

This rebuilds the implementations, verifies behavior and ownership, runs the Python
CI regressions and shared serializer conformance, measures the three comparison
leagues, and tests installed clients. `make check` requires `BUILD=build` because
the pinned serializer/Codin harness uses that layout. Individual native protocol
targets accept a custom `BUILD` directory.

## Worker and dependencies

The completion run uses `bak:melodica-complete-20261020`, a Fedora 44 Incus worker
controlled from Alienware through the configured Bak remote. Its workspace is
`/work/melodica`; pinned language tools are under `/opt/melodica-tools`.
The initially selected host named Fedora became unreachable, and the user directed
the move to Bak. Final completion evidence comes from Bak.

Run the same validation inside that worker:

```sh
incus exec bak:melodica-complete-20261020 -- bash -lc '
  cd /work/melodica
  export ODIN=/opt/melodica-tools/odin/odin
  export ZIG=/opt/melodica-tools/zig/zig
  export NELUA=/opt/melodica-tools/nelua/nelua
  make check
'
```

For a fresh disposable Fedora or Ubuntu/Debian worker, install reference/native
build dependencies and the pinned tools:

```sh
sh scripts/ci-deps.sh reference
tools=$(mktemp -d /tmp/melodica-tools.XXXXXX)
for lane in odin zig nelua; do bash scripts/ci-toolchains.sh --install "$lane" "$tools"; done
export ODIN="$tools/odin/odin" ZIG="$tools/zig/zig" NELUA="$tools/nelua/nelua"
make check
```

The dependency script provisions compilers, Clang sanitizer runtimes, Python, Node.js,
tmux, JSON/crypto libraries and the libcurl/libao/FFmpeg reference headers inside
the worker. It rejects host package installation on an Atomic host.

| Tool | Pin |
|---|---|
| Odin | `dev-2026-09`, archive checksum verified by `ci-toolchains.sh` |
| Zig | `0.16.0`, archive checksum verified by `ci-toolchains.sh` |
| Nelua | `a58450563e2d2ec49bff499865c8b5cfdf6ff81a` |
| Codin | `555b5d6127e2f843ed4e015b40ece667052f1838` plus the checked-in compatibility patch |

Codin's scalar and protocol builds use its actual parser. The protocol build adds
the general C99 backend and compiles emitted output with both GCC and Clang.
Pinned upstream libpiano source remains unmodified throughout comparisons.

## Focused correctness checks

```sh
make test-libpiano test-libpiano-alloc test-json-oracle test-playlist-wire
make test-libpiano-sanitize
make libpiano-native
LIBPIANO_CORRECTNESS_ONLY=1 sh scripts/libpiano-differential.sh
PIANO_VERIFY_ONLY=1 python3 scripts/native-piano.py
```

The protocol comparison uses 14 shared probes per implementation. Native archives
also undergo 313 checks of their compiled ABI layouts and checks for C protocol
forwarding. The C gates include 102 allocation failures, 55 json-c oracle values,
255 request-byte variants, and all 14 suites under ASan/UBSan/leak detection.

Consumer and CI regression checks can run independently:

```sh
make test-pianobar-source
make test-install
python3 -m unittest discover -s tests -p 'test_ci*.py' -v
```

The [WebAssembly core](wasm.md) has a separate execution check:

```sh
make wasm test-wasm
```

This needs only Clang, LLD and Node.js 18.13 or newer. It links the actual `.wasm`,
instantiates it, exercises the C ABI and JavaScript binding, and verifies HTTP
loading. `make check` and the comparison workflow include this check; the workflow
retains `build/wasm/` with its other artifacts.

The historical consumer check compiles eight unchanged pinned pianobar application
objects against melodica's `piano.h`, using
`MELODICA_PIANO_LEGACY_GCRYPT`. Its dependency graph proves the replacement header
was included. Installation stages C, Odin, Zig, Nelua and Codin separately and
compiles a public client using each installation's static pkg-config flags.
The Python harness passes 52 regression tests; synthetic score outputs
inside those tests are fixtures.

## Performance and evidence

`native-ci.py` rebuilds and checks all five serializers, then runs the unchanged
five-workload comparison serially. Acceptance remains a normalized geometric mean
of at least 90% and a worst-workload ratio of at least 80%. The canonical Bak
completion run passed for every lane: geometric means 93.5–98.6%, worst workloads
85.5–97.8%. The [retained standings](evidence/completion-2026-10-21/serializer/standings.txt)
contain all normalized workload ratios and the unchanged thresholds.

`libpiano-differential.sh` establishes the C/reference baseline and times 11 full
API fixture suites plus scaled playlists of 4, 64 and 256 songs.
`native-piano.py` compares the four native archives and measures all six
participants: upstream, C, Odin, Zig, Nelua and Codin. Each process uses five-round
medians; both execution orders are retained. API rates count complete suites.

Baseline manifests validate the pinned reference, fixture/source hashes, compiler
identity and artifacts. Correctness-only records are distinct from complete timing
records. Failed or stale inputs cause an explicit failure or a baseline rebuild;
rankings are withheld when a required lane fails. Avoid concurrent compilation or
other benchmark runs during a timed comparison.

All three CI jobs share one repository concurrency group with `queue: max`, so
their builds and timings run sequentially without replacing pending checks.
This uses GitHub's [multiple-pending-job queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
The differential job also checks installation of every protocol variant.

| Evidence location | Contents |
|---|---|
| `build/native-evidence`, `build/toolchain-evidence`, `build/shootout` | Toolchains, shared conformance, compiler/artifact details and serializer standings |
| `build/libpiano-evidence`, `build/sanitize` | Pinned baseline, 14 C comparisons, safety checks, API timings and manifests |
| `build/native-piano-evidence` | Native ABI/protocol comparisons, symbols, dependencies and six-way timings |
| `build/pianobar-source-evidence` | Historical consumer build, replacement-header verification and object hashes |
| `build/install-smoke` | Five staged installations, pkg-config flags and public-client results |

The retained completion snapshot is
[docs/evidence/completion-2026-10-21](evidence/completion-2026-10-21/).
Reports include source/artifact hashes, compiler settings, archive bytes and dynamic
dependencies. Archive sizes exclude separately linked runtime libraries.

## GitHub runner routing

Both workflows default to the Fedora 44 Incus worker label vector:

```text
self-hosted, Linux, X64, fedora44, spaceghost-melodica.h
```

Manual dispatch also supports `runner=github-hosted`. Worker dependencies support
Fedora and Ubuntu/Debian. The default routes jobs to the task-owned Fedora worker
on Bak; run the bounded controller below to provide up to three ephemeral runners.
This label does not match the existing Ubuntu worker broker. The retained
completion snapshot establishes the manual validation
results above. GitHub workflow runs provide the CI job results; release evidence
also retains the one-job controller's assigned job identities and cleanup records.

Workflows print readable evidence even when artifact upload fails. Source and
behavior failures retain their exit status and logs. The repository-scoped worker
controller owns registration, execution and cleanup through the configured Bak
remote; its final activation state is recorded separately from benchmark results.

The bounded controller runs from Alienware, where the existing `gh` authentication
and Bak Incus remote are available. Inspect the task-owned builder and matching
queued jobs first:

```sh
python3 scripts/ci-once-bak.py --sha "$(git rev-parse HEAD)"
```

After the manual timing window is complete, explicitly start at most three jobs:

```sh
python3 scripts/ci-once-bak.py --sha "$(git rev-parse HEAD)" --apply --jobs 3
```

Each job gets a separate unprivileged clone of the task-owned builder, a verified
official runner archive and one ephemeral repository registration. Registration
tokens travel through stdin. The controller checks that the clone has no host
mounts or account credential files, records the assigned job and conclusion, then
removes the exact runner and owner-marked clone. Controller plans, listener logs
and cleanup results are saved under `~/.local/state/melodica-ci-once/`. These
commands document the execution path; they do not establish that CI has run.

Earlier [CI failure tests](evidence/ci-local-2026-09-14.txt) and
[pool diagnostics](evidence/tmux-pool-local-2026-09-14.txt) remain historical records.
See the [completeness ledger](libpiano-completeness.md) for the current API contract.
