# melodica.h

A tiny, allocation-free C99 protocol helper for Pandora-style JSON/REST clients, authored in Nelua and shipped as one generated header.

```c
#define MELODICA_IMPLEMENTATION
#include "melodica.h"
```

The host owns HTTPS, cookies/tokens, storage, scheduling, and audio. `melodica.h` owns the annoying small pieces: JSON scalar lookup, JSON escaping, and compact request bodies for the REST calls we actually use.

## Why this shape

`melodica.h` is deliberately not a port of pianobar. It is a clean small C ABI aimed at Swift/Objective-C, C, Zig, embedded firmware, and WASM. There are no mandatory dependencies, no global state, no allocator, no libcurl, no JSON DOM, and no audio stack.

The REST endpoints implemented here are unofficial and may change. The library contains no credentials, auth-token acquisition tricks, DRM circumvention, or service-specific secrets.

## The bake-off

We keep several implementations in-tree and make them compete:

- `impl/scan`: structural single-pass scanner. The correctness baseline.
- `impl/hash`: structural scanner with FNV-1a key prefiltering.
- `impl/tiny`: very small validated substring scanner.

All candidates expose the exact same C ABI. `tools/bakeoff.sh`:

1. compiles every Nelua candidate to compact C99;
2. amalgamates each into a standalone header;
3. runs the same adversarial conformance suite;
4. benchmarks eligible candidates on the same runner;
5. measures header and object size;
6. chooses the lowest weighted score, with hysteresis so noisy CI does not flap releases;
7. writes the winner to `dist/melodica.h`.

Correctness is a gate, not a score. A fast wrong parser receives the traditional benchmark prize of **nothing**.

## Build

The project pins our Nelua fork for compact distributable C output and uses Zig 0.16 as the C toolchain.

```sh
./tools/bootstrap-nelua.sh
./tools/bakeoff.sh
```

The resulting public artifact is:

```text
dist/melodica.h
```

Consumers do not need Nelua or Zig.

## API

```c
int melodica_find_string(...);  /* zero-copy offset + length */
int melodica_find_bool(...);
int melodica_find_u64(...);
int melodica_json_escape(...);
int melodica_login_body(...);
int melodica_stations_body(...);
int melodica_playlist_body(...);
int melodica_feedback_body(...);
```

Every function is caller-buffered and returns a `MELODICA_*` status code. String lookup returns offsets into the caller's JSON buffer; no hidden lifetime rules exist.

## Development rule

`master` is the integration branch. Candidate implementations coexist instead of living on feature branches. New ideas enter as another candidate or improve an existing one, then the bake-off determines whether they deserve the release artifact.

See [`DESIGN.md`](DESIGN.md) for the scoring and ABI rules.
