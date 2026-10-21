# melodica.h

A portable serializer library and a complete implementation of the defined
historical libpiano API, with five implementations behind the same public C ABI.

| Implementation | Protocol implementation | Protocol runtime dependencies |
|---|---|---|
| C99 | Owned JSON parser and Blowfish implementation | C standard library |
| Odin | Native Odin procedures | json-c, libgcrypt |
| Zig | Native Zig procedures | json-c, libgcrypt |
| Nelua | Native Nelua procedures compiled through its C backend | json-c, libgcrypt |
| Codin | Odin dialect parsed by pinned Codin and lowered by the general C99 backend | json-c, libgcrypt |

Each native protocol archive implements its own public functions. Codin consumes
its Odin dialect source through the actual compiler parser; its generated C does
not forward protocol operations to the C compatibility implementation.

## Historical libpiano API

`include/piano.h` preserves the upstream structs, enum values, ownership model and
public functions. All 23 normal request/response kinds are implemented, including
login, playlists, search, stations, feedback, seeds, genres, bookmarks, settings
and station modes. `MELODICA_LIBPIANO_RPC_IMPLEMENTED` is enabled.

`ADD_FEEDBACK` request construction is also implemented. Its direct successful
response returns `PIANO_RET_ERR`: the pinned upstream asserts on that low-level
response path, which has no defined successful contract.

Fourteen differential probes compare every implementation with untouched
`PromyLOPh/pianobar` revision `ad5ec908de10479ecee7d7c0e1030d12146f8f16`.
They cover wire bytes, state, owned results, login boundaries, escaped and duplicate
JSON keys, coercions, public ABI layouts and errors. Native archives additionally
pass 313 checks of their actual compiled type layouts. The C parser has allocation
failure, json-c oracle, ASan, UBSan and leak checks. These are offline comparisons;
live Pandora service access is outside their scope.

## Standalone portable core

```c
#define MELODICA_IMPLEMENTATION
#include <melodica.h>
```

The core header provides binary-safe, allocation-free URL encoding, JSON escaping
and station-list request serialization. Sizes exclude a NUL terminator; a null
destination or insufficient capacity produces no writes. It is also available as
`libmelodica.a` through the shared serializer ABI.

## Build and verify

```sh
make libpiano                 # Portable C protocol archive
make test-libpiano            # C public API, playlist and search checks
make libpiano-native          # Odin, Zig, Nelua and Codin protocol archives
make test-native-libpiano     # Native ABI and pinned protocol comparisons
```

```sh
make check                    # Complete checks, comparisons, timings and installation
make test-install             # Compile installed clients for all five protocol variants
sh scripts/pianobar-source-compat.sh # Compile unchanged historical application sources
make test-pianobar-integration # Link the full application and check startup/audio offline
```

C requires a C99 compiler and make. Native protocol variants require their pinned
language toolchains plus json-c and libgcrypt development packages. Reference
comparisons also require libcurl, libao and FFmpeg development packages; sanitizer
checks use Clang and its runtimes. [CI setup](docs/ci.md) provides dependency and
toolchain installation commands. The pure C protocol archive does not require
json-c or libgcrypt at runtime.

Historical consumers that used gcrypt declarations transitively from `piano.h`
can compile with `-DMELODICA_PIANO_LEGACY_GCRYPT`.

## Install and use

Choose `PIANO_IMPL=c`, `odin`, `zig`, `nelua` or `codin`. Installation provides both
public headers, `libmelodica.a`, the selected `libpiano.a`, pkg-config metadata and
the retained license notice. `DESTDIR` supports staged packaging.

```sh
make install PIANO_IMPL=c PREFIX="$HOME/.local"
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
cc -std=c99 examples/compat-client.c $(pkg-config --static --cflags --libs piano) -o compat-client
./compat-client
```

`pkg-config --static` includes the selected native variant's link dependencies.
The [offline example](examples/compat-client.c) uses only the public installed API.
The [pianobar integration](docs/pianobar-integration.md) builds the complete pinned
application with this library and verifies its actual player using synthetic audio.

## Three comparison leagues

| League | Work measured | Acceptance |
|---|---|---|
| Serializer | Five unchanged workloads across C, Odin, Zig, Nelua and Codin | Geometric mean ≥90% of the leader; every workload ≥80% |
| Full API | Complete request/response fixture suites | Identical pinned behavior before timing |
| Scaled playlists | Parse, build and free 4, 64 or 256 songs | Identical results and owned cleanup before timing |

Reports retain five-round medians and opposite execution orders on the same host.
Compiler versions, flags, source and artifact hashes, archive sizes and dynamic
dependencies accompany the results. API suite rates count entire suites; playlist
rates count requests. Archive bytes exclude external runtime libraries.

See the [completeness ledger](docs/libpiano-completeness.md) for the exact contract
and retained evidence, [CI documentation](docs/ci.md) for reproducible commands, and
the [libpiano MIT notice](LICENSE.libpiano) for the original attribution.
