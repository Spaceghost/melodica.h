# melodica.h

A portable reimplementation of the useful `libpianobar`/`libpiano` core, developed as competing language implementations behind one C ABI.

The product goal is deliberately obnoxious in a useful way: **one tiny library that can be embedded as a single C header, while also becoming a practical drop-in `libpiano` replacement for existing pianobar-era callers.** Correctness comes first; speed, generated/native size, portability, dependency weight and source quality decide the shootout.

## Current lanes

| lane | source | build | role |
|---|---|---|---|
| portable C99 | `include/melodica.h`, `impl/c` | single-header implementation / static library | portability baseline + winner-eligible |
| Odin | `impl/odin` | native Odin static library | winner-eligible |
| Codin C99 | `impl/codin` | `Spaceghost/codin` → strict C99 → GCC/Clang | winner-eligible |
| Codin native | `impl/codin` | native Odin static library | control only |

`Spaceghost/codin` now owns the compiler backend. `melodica.h` pins a known-green compiler revision instead of carrying a secret patch stack in the application repo. Codin currently has the deliberately staged C99 ladder: minimal sema and range lowering, structs, fixed arrays, enums, slices/strings, multiple returns, `defer`, tagged unions, imports and narrow `$T` monomorphization. Unsupported shapes fail loudly.

## Portable single-header core

The common ABI currently provides allocation-free, binary-safe primitives used by the protocol layer:

- RFC 3986 percent encoding
- JSON string escaping
- ABI/version reporting

For the zero-dependency C implementation:

```c
#define MELODICA_IMPLEMENTATION
#include <melodica.h>
```

That implementation is strict C99 and has no runtime libc dependency. CI compiles it normally and as a freestanding `wasm32` object.

## libpiano compatibility

`include/piano.h` now exposes the historical public data model, request/error enums, linked-list helpers and function names. `libpiano.a` currently implements:

- list append/prepend/delete/get/count with the original intrusive-list semantics
- `PianoInit`/`PianoDestroy` portable ownership and lifecycle
- playlist/search/station-info/station-mode destruction
- request destruction
- `PianoFindStationById`
- `PianoErrorToStr`

The old libgcrypt compile-time dependency is gone; cipher handles are opaque pointer-sized compatibility fields. **RPC construction and response parsing intentionally still return explicit failure rather than pretending Pandora network compatibility exists.** Those are the next major completeness milestones, followed by crypt/auth transport and a real pianobar compatibility build.

## Build / test / install

```sh
make test          # C + Odin + native Codin control + libpiano compatibility
make codin-check   # Codin -> strict C99 -> GCC + Clang + feature fixtures
make portable      # freestanding native + wasm32 C objects
make bench         # language shootout microbenchmarks
make install       # portable C libmelodica.a + libpiano.a + headers
```

CI pins Odin `dev-2026-09` by SHA-256 and pins Codin by commit. Every implementation lane must remain bit-for-bit behavior-compatible with `include/melodica.h` on the shared tests.

## Completeness path

The next product slices are intentionally concrete:

1. reproduce libpiano request JSON generation without libgcrypt coupling;
2. reproduce response parsing and ownership semantics with fixture/golden tests;
3. isolate auth/crypto behind a tiny provider interface so hosted, embedded and browser/WASM builds can choose implementations;
4. compile a real pianobar consumer against `include/piano.h` as a source-compatibility gate;
5. grow the language shootout from primitives into the same protocol/state-machine fixtures so the winner is chosen on useful work, not one pleasant microbenchmark.
