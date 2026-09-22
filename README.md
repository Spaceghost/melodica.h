# melodica.h

A portable libpiano reimplementation, with independently implemented native
serializer lanes behind one C ABI. Correctness and observable upstream behavior
come before performance claims.

## Two comparison surfaces

| Surface | Implementations | What is compared |
|---|---|---|
| Allocation-free serializer ABI | C99, Odin, Zig, Nelua, Codin C99 | URL encoding, JSON escaping and station-request construction |
| Historical `piano.h` API | melodica C compatibility library versus pinned upstream libpiano | Request bytes, response data, return values, state and ownership |

Codin native remains an Odin-compiled control, not another independent winner.
Nelua disables GC and exports fixed C names through its C backend. The full
`piano.h` implementation is **not yet implemented independently in all five
languages**. A serializer score is not evidence of full libpiano compatibility.

## Portable core

```c
#define MELODICA_IMPLEMENTATION
#include <melodica.h>
```

The strict-C99 core provides binary-safe, allocation-free percent encoding, JSON
escaping, station-list request serialization, and ABI/version reporting. Output
sizes exclude a NUL terminator. A null destination or insufficient capacity
causes no writes. The existing five-lane workloads and this contract are unchanged.

## Implemented libpiano subset

`include/piano.h` preserves the historical public names and data model.
`libpiano.a` contains portable lifecycle/list helpers, destruction functions,
station lookup, error mapping, owned JSON parsing and Blowfish support. Request
and response handling currently covers:

- Two-step partner/user login with encrypted sync-time handling.
- Authenticated station-list retrieval and QuickMix membership flags.
- Playlist retrieval with TLS selection, exact spaced request JSON and
  encryption, low/medium/high audio selection, metadata, ad-item filtering,
  unavailable-quality errors and caller-owned output.

Unsupported successful response types now return `PIANO_RET_ERR` rather than
silently reporting completion. The API remains partial:
`MELODICA_LIBPIANO_RPC_IMPLEMENTED` stays zero. No live Pandora playback or network
interoperability claim is made by these offline fixtures.

Product code does not depend on json-c or libgcrypt. The independent test oracle
and upstream reference do. `MELODICA_PIANO_LEGACY_GCRYPT` is available for old
consumers that depended on transitive gcrypt declarations from `piano.h`.

## Build and test

```sh
make test-libpiano             # Existing compatibility tests plus playlist tests
make test-playlist-alloc       # Allocation-failure/ownership sweep; GNU-compatible linker
make test-playlist-wire        # Independent json-c wire oracle; requires json-c development files
make test-playlist-sanitize    # Clang ASan, UBSan and leak checks
make bench-libpiano            # Full playlist parse/build/free benchmark
sh scripts/libpiano-differential.sh # Pinned unmodified upstream versus melodica

make test                     # All native serializer lanes plus compatibility tests
make codin-check              # Codin -> strict C99 -> GCC/Clang checks
make portable                 # Freestanding/cross-target C builds
make shootout                 # Existing five-workload normalized serializer scoreboard
make shootout-gate            # >=90% geometric mean and >=80% worst-workload target
make install                  # C libmelodica.a, libpiano.a and public headers
```

The differential script needs git, make, a C compiler, pkg-config, and upstream
libcurl/libgcrypt/json-c build dependencies. CI provisions them. Upstream is pinned
in `tests/reference/pianobar.rev`; its source is not patched. The same probes are
linked against both libraries. Complete playlist benchmarks use matching `-O2`,
no LTO/native-CPU tuning, five-run medians, and both execution orders. They are a
separate comparison from the five-language serializer leaderboard.

The differential workflow retains plaintext/ciphertext comparisons, timings,
compiler information, archive sizes and dynamic dependencies, including evidence
available before a failed check. A pre-setup runner failure is not a source or
performance verdict.

See [the completeness ledger](docs/libpiano-completeness.md) for supported
behavior, remaining work, and the exact scope of current validation.
