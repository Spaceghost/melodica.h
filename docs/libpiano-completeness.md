# libpiano completeness and shootout contract

## Reference and scope

Reference: `PromyLOPh/pianobar` commit
`ad5ec908de10479ecee7d7c0e1030d12146f8f16`, pinned in
`tests/reference/pianobar.rev`. Request and response behavior is read from
`src/libpiano/request.c` and `src/libpiano/response.c` at that revision.
The differential script builds these unmodified alongside upstream piano/list/crypt.

PR #1 was merged into main at `a19d32615908b68b94a1748c7e05a5123937669e`.
Its five native serializer lanes must not be mistaken for five complete libpiano
implementations. Full API behavior is currently in the shared C compatibility
library; independent lane expansion is a separate acceptance gate.

## Request/response inventory

Three of the 24 public request kinds now have implementations on both sides of
the request/response boundary. This is an inventory, not a claim that every input
or upstream quirk for these kinds has already been differentially verified.

| Request family | Status | Evidence / remaining work |
|---|---|---|
| LOGIN | Implemented | Existing two-step login and error fixtures; repeat in pinned differential gate |
| GET_STATIONS | Implemented | Existing station list and QuickMix flag fixtures |
| GET_PLAYLIST | Implemented in this slice | 3 request cases, 12 response cases, independent wire oracle and safety tests; full upstream differential run still required |
| SEARCH | Pending | Query bytes, artist/song parsing, scores, ownership |
| RENAME_STATION, DELETE_STATION, CREATE_STATION | Pending | Wire bytes and successful local list/state updates |
| RATE_SONG, ADD_FEEDBACK, ADD_TIRED_SONG | Pending | Delegation, ratings, low-level feedback semantics |
| ADD_SEED, DELETE_SEED, DELETE_FEEDBACK, GET_STATION_INFO | Pending | Nested owned data and mutation effects |
| SET_QUICKMIX, GET_GENRE_STATIONS, TRANSFORM_STATION | Pending | Lists, genres and creator-state transitions |
| EXPLAIN, BOOKMARK_SONG, BOOKMARK_ARTIST | Pending | Text assembly and exact request payloads |
| GET_SETTINGS, CHANGE_SETTINGS | Pending | Settings ownership, tristates and optional members |
| GET_STATION_MODES, SET_STATION_MODE | Pending | Mode fields, active selection and response effects |

The existing public data layout and serializer ABI are unchanged. Unsupported
`PianoResponse` success envelopes now return `PIANO_RET_ERR`; they must not count
as implemented merely because the server reported `stat: ok`.

## Playlist slice

The request uses `station.getPlaylist`, `secure=true`, the upstream member order
and json-c's historical spaced JSON serialization. Slash escaping and lowercase
control escape hex digits are wire behavior because the bytes are encrypted.
The control-digit fix also corrects the shared login/station JSON writer; URL
percent-escape hex remains uppercase.

Response handling selects the requested low, medium or high quality, maps
`aacplus`/`mp3`, preserves unknown encodings as UNKNOWN, and skips items without
`artistName`. It copies artist, album, title, track/station tokens, URLs, gain,
length and rating. Missing optional strings remain null; a missing audio map is
allowed, as in the reference. An existing map lacking the requested quality or
encoding produces `PIANO_RET_QUALITY_UNAVAILABLE`.

Output is built privately. On late failure it is destroyed and the caller's
`retPlaylist` remains unchanged. Missing `items` also leaves that output unchanged;
an empty `items` array sets it to null. Successful replacement does not free a
pre-existing caller-owned playlist. Callers destroy returned playlists explicitly.
Request destruction continues not to own `responseData` or request `data`.

Token traversal is one forward pass through playlist items, and a tail pointer
avoids repeatedly traversing the list to append songs. Metadata lookup remains
linear within each item's token subtree. This is not a claim of a fully indexed
JSON parser or bounded response allocation.

## Validation boundaries

Local execution on September 14, 2026:

- Real compatibility sources built with GCC 14.2.0 under strict C99; the shared
  playlist probe passed 3 request and 12 response cases.
- An independent installed json-c oracle matched request JSON for all 255 non-NUL
  input byte values, including control escapes. json-c is test-only.
- Metadata, malformed structures, invalid quality, absent/empty results,
  unavailable quality and unsupported response behavior passed local tests.
- Every one of 44 allocation positions in a four-song response was fault-injected:
  no leak and no caller-output mutation. The existing JSON API can report token
  allocation failure as INVALID_RESPONSE rather than OUT_OF_MEMORY; the test
  records that limitation rather than hiding it.
- Clang 17 ASan, UBSan and leak detection passed the shared probe and allocation
  failure suite. This is local execution, not a GitHub-hosted run.

The same new probe is wired to unmodified upstream, but that complete upstream
comparison was not executed locally: the execution environment has no network
access to obtain the reference and lacks libgcrypt development headers. The
previous hosted comparison also stopped before setup. A successful independent
json-c oracle does **not** substitute for a completed full upstream differential run.

Malformed-input guardrails intentionally reject null/non-string song fields,
invalid containers and non-finite/overflowing gains rather than reproducing
upstream crashes or undefined conversions. Valid JSON numeric strings, booleans,
null/missing optional numbers and integer saturation have fixtures. Escaped object
keys, duplicate keys and all permissive json-c coercions are not yet comprehensively
matched by the existing JSON parser. These remain explicit compatibility gaps.

## Actual local performance and size

Same-host native C compatibility library, GCC 14.2.0 `-O2`, x86_64 AMD EPYC 9V74.
No LTO or native-CPU flags. The benchmark validates counts, consumes output, and
includes allocation, parsing, list construction and destruction. Five measured
rounds follow an equal-work warmup.

| Songs per response | Requests/second, local median |
|---:|---:|
| 4 | 168,286 |
| 64 | 10,669 |
| 256 | 2,506 |

The new feature previously returned failure, so these are initial measurements,
not speedup ratios. The comparable local archives grew from 49,906 to 56,586 bytes
with the playlist implementation. Archive bytes include non-runtime metadata and
do not represent stripped code size. Raw command/output and source fingerprints
are retained in `docs/evidence/playlist-local-2026-09-14.txt`.

No new normalized five-language ranking is asserted. Their five workloads and
90% geometric-mean / 80% worst-workload targets remain unchanged. C-model experiments
must never be described as measured improvements in Odin, Nelua or another lane.

## Next acceptance slices

First obtain a completed pinned upstream playlist differential run. Then implement
SEARCH and station mutations, including their response-side ownership/state changes.
Follow with feedback/rating, seed/station information, QuickMix/genres,
explanation/bookmarks, settings and modes. Each slice adds identical upstream and
candidate probes before it becomes eligible for performance claims.

Expand the native language implementations on a common, independently implemented
feature surface with the same buffer/error tests. Do not route all languages through
the C compatibility library and call that language parity. Preserve the primitive
league while adding complete protocol workloads as a separately versioned suite.
