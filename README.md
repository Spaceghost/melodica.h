# melodica.h

A small, allocation-free C99 protocol library for Pandora-style JSON/REST clients, authored primarily in Nelua and shipped as one generated header.

```c
#define MELODICA_IMPLEMENTATION
#include "melodica.h"
```

The host owns HTTPS, CSRF cookies, auth-token persistence, storage, scheduling, and audio. `melodica.h` owns request bodies and response parsing machinery useful across hosts.

## Competitive implementation league

Permanent first-class competitors behind the same hot-path ABI:

- C99
- Nelua -> C99
- Zig native
- Zig -> C
- Odin through the official native compiler

Tracked Odin compiler implementation:

- Codin (`graphitemaster/codin`) -> intended Odin-to-C backend. The pinned upstream compiler currently builds and parses our full lookup kernel in CI, but its public CLI does not yet expose C emission, so it does not receive a fabricated benchmark row. When C output exists, it becomes `odin-codin` beside official `odin` in the shared conformance/timing league.

Active challengers:

- Nim -> C
- Gambit Scheme -> C
- Spinel Ruby -> C (one-shot probation until it posts a real common-ABI result)
- Vala -> C (same probation rule)

A compiler does not stay merely because it can emit C. New backends get one serious common-ABI baseline and remain only if they are plausibly competitive on speed/size or expose an optimization we can realistically port.

A native Zig or Odin win is useful even though the released artifact remains C99: it becomes the algorithm/codegen target the shippable C99 implementations must catch.

## Zero-copy protocol core

Tracks, stations, and login responses are offsets and lengths into the caller's original JSON buffer. Collection iterators walk playlist/station arrays without allocating a JSON tree. Request writers cover login, stations, playlist fragments, feedback, tired-song, narrative, track-started, playback-paused/sync, station details, and station feedback.

## Release bake-off

Four Nelua-authored release implementations coexist on `master` behind one ABI: `scan`, `hash`, `tiny`, and `dispatch`. `tools/bakeoff.sh` gates them on conformance and sanitizers, benchmarks eligible builds, measures object/header size, cross-compiles the winner, and promotes it to `dist/melodica.h`.

The release remains one dependency-free C99 header. Consumers do not need Nelua, Zig, Odin, Nim, Gambit, or any experimental compiler.

## Development rule

`master` is the integration branch. Comparative implementations coexist in-tree. The implementation lab is competitive-only: no backend survives indefinitely as a language-demo exhibit.

See [`DESIGN.md`](DESIGN.md), [`C99_EMITTERS.md`](C99_EMITTERS.md), and [`lab/`](lab/README.md).
