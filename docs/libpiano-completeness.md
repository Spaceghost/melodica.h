# libpiano completeness and comparison contract

## Reference and completion scope

The compatibility reference is unmodified
[`PromyLOPh/pianobar` at `ad5ec908de10479ecee7d7c0e1030d12146f8f16`](https://github.com/PromyLOPh/pianobar/tree/ad5ec908de10479ecee7d7c0e1030d12146f8f16),
pinned in [pianobar.rev](../tests/reference/pianobar.rev). All five protocol
implementations pass the same 14 differential probes against that reference.
`MELODICA_LIBPIANO_RPC_IMPLEMENTED` is enabled.

Completion covers the reference's defined public behavior: request construction,
responses, return values, state changes, public ABI and ownership. Cases in which
the reference asserts or dereferences a null string have no successful response
contract; melodica returns a safe error for those inputs.

## Request and response inventory

All names below use the `PIANO_REQUEST_` prefix. The 23 normal request kinds have
both request and response implementations in C, Odin, Zig, Nelua and Codin.

| Group | Request kinds | Status |
|---|---|---|
| Authentication and catalog | LOGIN, GET_STATIONS, GET_PLAYLIST, SEARCH, GET_GENRE_STATIONS | Complete |
| Station management | RENAME_STATION, DELETE_STATION, CREATE_STATION, TRANSFORM_STATION, SET_QUICKMIX | Complete |
| Ratings, seeds and station data | RATE_SONG, ADD_TIRED_SONG, ADD_SEED, DELETE_FEEDBACK, DELETE_SEED, GET_STATION_INFO | Complete |
| Explanation, bookmarks and preferences | EXPLAIN, BOOKMARK_SONG, BOOKMARK_ARTIST, GET_SETTINGS, CHANGE_SETTINGS, GET_STATION_MODES, SET_STATION_MODE | Complete |
| Low-level feedback | ADD_FEEDBACK | Request construction complete; direct successful response returns `PIANO_RET_ERR` |

The `ADD_FEEDBACK` exception is intentional: RATE_SONG delegates to its request
builder, while the pinned upstream asserts on a direct successful ADD_FEEDBACK
response. No successful behavior is invented for that path.

Requests preserve the historical method names, TLS choices, JSON member order,
json-c spaced formatting, control/slash escaping and encrypted bytes. Boundary
fixtures cover signed 32-bit sync-time conversion, signed partner-id formatting
and successful URL truncation by the reference's fixed-size buffer.

## Implementations and ABI

| Implementation | Protocol code | Runtime dependencies |
|---|---|---|
| C99 | Native parser, request/response handling and Blowfish | C standard library |
| Odin | Native Odin implementation | json-c, libgcrypt |
| Zig | Native Zig implementation | json-c, libgcrypt |
| Nelua | Native Nelua implementation through its C backend | json-c, libgcrypt |
| Codin | Odin dialect through the actual pinned Codin parser and general C99 lowering backend | json-c, libgcrypt |

Each native archive supplies its own public API functions and passes symbol checks
for imports of C compatibility internals. The Codin protocol package adapts the
Odin port and compiles through Codin; compiling it with Odin is a separate control.
[The compiler compatibility patch](../scripts/codin-compat.patch) fixes absent AST
arrays and discard assignments. [Provenance](../THIRD_PARTY_NOTICES.md) and the
[original MIT notice](../LICENSE.libpiano) are retained.

The shared ABI probe compares public sizes, alignments, field offsets, enum values
and defined error strings with upstream. Each native implementation also passes
313 checks of its actual compiled type layouts, beyond compiling a C harness
against `piano.h`.

## Parsing and ownership

The JSON compatibility probes cover decoded member names, last-value duplicate
keys, strings and container-to-string serialization, boolean truthiness, numeric
prefixes, integer saturation, floating-point conversion and Unicode replacement.
They also cover the reference parser's comments, trailing commas, single quotes,
case-insensitive primitives and trailing text acceptance.

Response fixtures cover empty, absent and scalar results where upstream defines
behavior; playlist quality selection and ad filtering; same-id station replacement;
QuickMix membership; station seeds/feedback; explanation punctuation; settings;
and active mode verification.

Ownership follows the historical API. The handle owns user, station, genre and
cipher data. Callers own returned playlists, search results, station information,
modes, settings strings and explanations. `PianoDestroyRequest` frees its post body
and leaves response-buffer ownership with the caller. Search/station-info
destructors free their lists without clearing the caller's fields; reset those
structures before reuse. Settings and explanation responses can replace output
pointers, so callers remain responsible for prior outputs.

C playlist, station-info, genre and station-mode parsers build private results
before committing successful output. Allocation-failure checks also verify search
cleanup and unchanged settings/explanation outputs on failure. These checks cover
102 allocation positions across seven owned-result paths, with no retained leaks
or partial output in the exercised failures.

## Completed correctness checks

| Check | Result |
|---|---|
| Pinned protocol differential | All five implementations match all 14 probes |
| Public and native ABI | Upstream ABI comparison and 313 native layout checks per native archive pass |
| C memory and wire checks | 102 allocation failures, 55 json-c accessor values and all 255 non-NUL request-byte variants pass |
| Sanitizers | All 14 C probe suites and allocation sweeps pass ASan, UBSan and leak checks |
| Consumer integration | Eight unchanged historical application objects compile; installed clients for all five variants agree |

The shared serializer conformance suite also passes 1,591 cases and 125,022 checks
per implementation. These are offline checks; network transport and live Pandora
service access are outside the fixture contract.

## Three comparison leagues

| League | Participants and work | Acceptance |
|---|---|---|
| Portable serializers | C, Odin, Zig, Nelua and emitted Codin C99; five unchanged workloads | Geometric mean at least 90% of the leader and every workload at least 80% |
| Full libpiano API | Upstream reference plus all five implementations; 11 complete API fixture suites | Exact differential results before timing; rates are suites/s |
| Scaled playlists | The same six participants; parse, build and free 4, 64 or 256 songs | Matching results and ownership cleanup before timing; rates are requests/s |

Measurements use five-round process medians and two opposite execution orders on
the same host. Compiler options, source/artifact hashes, archive sizes and dynamic
dependencies accompany the results. Archive bytes exclude external shared libraries.
The C implementation's dependency boundary is recorded separately from native
json-c/libgcrypt dependencies.

**Performance acceptance:** final coordinated serializer gate and six-way API /
playlist measurements are pending. Correctness results above are complete; no
final performance ranking is asserted here until the retained reports are complete.

## Reproduce and inspect

Run `make check` for the complete default-build validation. Individual checks are
listed in [CI documentation](ci.md), including native protocol archives, fault
injection, sanitizers, installed clients and historical consumer compilation.

The completion environment is a Fedora 44 Incus worker on Bak. Current retained
reports belong in [completion-2026-10-21](evidence/completion-2026-10-21/); source
hashes and compiler records identify the exact inputs. Earlier
[playlist](evidence/playlist-local-2026-09-14.txt) and
[station-mode](evidence/station-modes-local-2026-09-14.txt) logs are historical
checkpoints, superseded by the coordinated Bak completion evidence.
