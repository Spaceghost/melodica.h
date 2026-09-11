# melodica.h

A small, allocation-free C99 protocol library for Pandora-style JSON/REST clients, authored in Nelua and shipped as one generated header.

```c
#define MELODICA_IMPLEMENTATION
#include "melodica.h"
```

The host owns HTTPS, CSRF cookies, auth-token persistence, storage, scheduling, and audio. `melodica.h` owns request bodies and the response parsing machinery that is useful to share across hosts.

## Why this shape

`melodica.h` is deliberately not a line-for-line port of libpiano. It keeps the useful protocol layer while replacing linked lists, hidden ownership, and transport policy with a small C ABI suitable for Swift/Objective-C, C, Zig, embedded firmware, and WASM.

There are no mandatory dependencies, no global runtime state, no allocator, no libcurl, no JSON DOM, and no audio stack.

The REST endpoints are unofficial and may change. The library contains no credentials, DRM circumvention, service secrets, or bundled account state.

## Response views

Parsed strings are slices into the caller's original JSON buffer:

```c
melodica_track_view track;
if (melodica_parse_track(json, json_len, &track) == MELODICA_OK &&
    (track.present & MELODICA_TRACK_SONG_TITLE)) {
    const char *title = json + track.song_title.offset;
    size_t title_len = track.song_title.length;
}
```

Station and playlist responses can be walked without allocation or a JSON tree:

```c
size_t cursor = 0;
melodica_track_view track;

while (melodica_track_next(json, json_len, &cursor, &track) == MELODICA_OK) {
    /* every string slice still points into json */
}
```

`melodica_station_next` works the same way. Initialize the cursor to zero and keep it unchanged between calls; `MELODICA_NOT_FOUND` means the array is exhausted or absent.

## Request helpers

The current modern REST surface covers:

- login: `/api/v1/auth/login`
- stations: `/api/v1/station/getStations`
- playlist fragments: `/api/v1/playlist/getFragment`
- thumbs feedback: `/api/v1/station/addFeedback`
- tired song: `/api/v1/listener/addTiredSong`
- narrative/explanation: `/api/v1/playlist/narrative`

All body writers escape caller strings and write into caller-provided buffers.

## The bake-off

Several implementations live together on `master` and expose exactly the same C ABI:

- `impl/scan`: structural scanner and correctness baseline.
- `impl/hash`: structural scanner with FNV-1a key prefiltering.
- `impl/tiny`: compact validated substring scanner.
- `impl/dispatch`: tiny-style generic lookup plus a one-pass known-key track parser.

`tools/bakeoff.sh` generates every candidate, gates it on conformance and ASan/UBSan, benchmarks eligible builds, measures header/object size, cross-compiles the exact winner, and writes the release to `dist/melodica.h`.

Timing is deliberately less gullible than a usual CI microbenchmark: all binaries are built first, warmed first, then measured in rotating round-robin order. The benchmark caller and `MELODICA_IMPLEMENTATION` live in separate translation units so unrelated generated functions cannot rewrite the caller's layout.

Correctness is a gate, not a score. A fast wrong parser receives the traditional benchmark prize of **nothing**.

The winner is recorded in `dist/WINNER`. A challenger must improve the weighted score by at least 3% before it displaces the incumbent.

## Build

The project pins our Nelua fork for compact distributable C output and uses Zig 0.16 as the C toolchain.

```sh
./tools/bootstrap-nelua.sh
./tools/bakeoff.sh
```

The public artifact is:

```text
dist/melodica.h
```

Consumers need neither Nelua nor Zig.

## API at a glance

```c
unsigned melodica_version(void);

int melodica_find_string(...);   /* zero-copy offset + length */
int melodica_find_bool(...);
int melodica_find_u64(...);

int melodica_parse_track(...);
int melodica_parse_station(...);
int melodica_track_next(...);
int melodica_station_next(...);

int melodica_json_escape(...);
int melodica_login_body(...);
int melodica_stations_body(...);
int melodica_playlist_body(...);
int melodica_feedback_body(...);
int melodica_tired_body(...);
int melodica_narrative_body(...);
```

Every function returns a `MELODICA_*` status code. There are no hidden lifetimes: views remain valid exactly as long as the caller's JSON buffer does.

## Development rule

`master` is the integration branch. Comparative implementations coexist in-tree instead of hiding on feature branches. New parsing ideas enter as another candidate or improve an existing one, and the bake-off decides what deserves `dist/melodica.h`.

Generated `dist/` promotion commits and documentation-only edits do not recursively rerun the bake-off. The pinned Nelua compiler is cached in Actions, so normal source pushes get directly to the useful part: proving the library still works and deciding who wins.

See [`DESIGN.md`](DESIGN.md) for the scoring and ABI rules.
