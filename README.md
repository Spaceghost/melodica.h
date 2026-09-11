# melodica.h

A small, allocation-free C99 protocol library for Pandora-style JSON/REST clients, authored in Nelua and shipped as one generated header.

```c
#define MELODICA_IMPLEMENTATION
#include "melodica.h"
```

The host owns HTTPS, CSRF cookies, auth-token persistence, storage, scheduling, and audio. `melodica.h` owns request bodies and the response parsing machinery that is useful to share across hosts.

## Why this shape

`melodica.h` is deliberately not a line-for-line port of libpiano. It keeps the useful protocol layer while replacing linked lists, hidden ownership, and transport policy with a small C ABI. There are no mandatory dependencies, no global runtime state, no allocator, no libcurl, no JSON DOM, and no audio stack.

The REST endpoints are unofficial and may change. The library contains no credentials, DRM circumvention, service secrets, or bundled account state.

## Zero-copy response views

Tracks, stations, and login responses are represented as offsets and lengths into the caller's original JSON buffer. `melodica_login_view` exposes `authToken`, `username`, `webName`, and `userId` without allocating or copying; track and station collection iterators use the same ownership model.

```c
melodica_login_view login;
if (melodica_parse_login(json, json_len, &login) == MELODICA_OK &&
    (login.present & MELODICA_LOGIN_AUTH_TOKEN)) {
    const char *token = json + login.auth_token.offset;
    size_t token_len = login.auth_token.length;
}
```

Initialize a `size_t cursor = 0` and call `melodica_track_next` or `melodica_station_next` until `MELODICA_NOT_FOUND` to walk playlist/station arrays without building a JSON tree.

## Modern REST helpers

The current request surface includes login, stations, playlist fragments, thumbs feedback, tired-song, narrative/explanation, track-started reporting, playback-paused/sync, station details, and station feedback. All body writers escape caller strings and write into caller-provided buffers.

## C99 emitter league

Language experiments have one admission rule: **the compiler implementation must emit C source that is accepted again in C99 mode**. Merely having a C ABI does not count.

The active common-ABI competitors are:

- C99
- Nelua
- Zig through its C backend (`-ofmt=c`)

The generated C from every challenger is compiled again with `-std=c99` before it may enter the benchmark. Native-only Odin, ordinary Rust, Go, Swift, Objective-C, and C++ consumers are intentionally not part of this project. A surface language may return through a different implementation that emits C: for example Spinel for Ruby or `rustc_codegen_c` for Rust.

The expansion pool intentionally favors strange source-to-C systems: Spinel, Nim, Scheme-to-C compilers, V, Vala, ATS/Postiats, Mercury, Idris2 RefC, Koka, Pallene, Cython, and older research compilers when they can still be made reproducible.

See [`C99_EMITTERS.md`](C99_EMITTERS.md) and [`lab/`](lab/README.md).

## The bake-off

Four implementations coexist on `master` behind one ABI:

- `scan`: structural correctness baseline
- `hash`: structural scanner with FNV-1a key prefiltering
- `tiny`: compact validated substring scanner
- `dispatch`: tiny-style generic lookup plus a one-pass known-key track parser

`tools/bakeoff.sh` compiles and amalgamates every candidate, gates it on conformance and ASan/UBSan, benchmarks eligible builds in rotating round-robin order, measures object/header size, cross-compiles the exact winner, and promotes the winner to `dist/melodica.h`.

The winner is recorded in `dist/WINNER`; the measurements that justified it are committed as `dist/BENCHMARK.tsv`. A challenger must improve the weighted score by at least 3% before replacing the incumbent. Correctness remains a gate, not a score. A fast wrong parser wins nothing, as nature intended.

## Build

```sh
./tools/bootstrap-nelua.sh
./tools/bakeoff.sh
```

Consumers need only `dist/melodica.h`; they do not need Nelua or Zig.

## Development rule

`master` is the integration branch. Comparative implementations coexist in-tree rather than hiding on feature branches. Generated release commits and C99-emitter/docs-only changes do not recursively wake unrelated bake-offs.

See [`DESIGN.md`](DESIGN.md) for scoring and ABI details.
