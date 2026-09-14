# libpiano completeness and shootout contract

## Reference and scope

Reference: `PromyLOPh/pianobar` commit
`ad5ec908de10479ecee7d7c0e1030d12146f8f16`, pinned in
`tests/reference/pianobar.rev`. The differential gate builds that source unmodified.
PR #1 merged the five native serializer lanes; those lanes are not yet five complete
libpiano implementations. Full API behavior remains a separate compatibility league.

## Request/response inventory

Nineteen of the 24 public request kinds now have implementations on both sides of the
request/response boundary: LOGIN, GET_STATIONS, GET_PLAYLIST, SEARCH,
RENAME_STATION, DELETE_STATION, CREATE_STATION, RATE_SONG, ADD_TIRED_SONG,
ADD_SEED, DELETE_FEEDBACK, DELETE_SEED, GET_STATION_INFO, SET_QUICKMIX,
GET_GENRE_STATIONS, TRANSFORM_STATION, EXPLAIN, BOOKMARK_SONG and BOOKMARK_ARTIST.
`ADD_FEEDBACK` request construction is implemented because RATE_SONG delegates to it,
but a successful direct ADD_FEEDBACK response is deliberately not counted: pinned
upstream asserts in that response case, and melodica returns `PIANO_RET_ERR` rather
than inventing a successful contract.

| Request family | Status | Evidence / remaining work |
|---|---|---|
| LOGIN | Implemented | Existing two-step login/error fixtures; pinned differential pending |
| GET_STATIONS | Implemented | Station list and QuickMix flag fixtures; pinned differential pending |
| GET_PLAYLIST | Implemented | Request/response, ownership, wire oracle, fault injection and local benchmark |
| SEARCH | Implemented, differential pending | Request bytes and owned artist/song results |
| RENAME_STATION, DELETE_STATION, CREATE_STATION | Implemented, differential pending | Request bytes and state/ownership effects |
| RATE_SONG, ADD_TIRED_SONG | Implemented, differential pending | Feedback delegation, request restoration and rating state effects |
| ADD_FEEDBACK | Request implemented | Direct successful response intentionally returns ERR; upstream asserts there |
| ADD_SEED, DELETE_FEEDBACK, DELETE_SEED | Implemented, differential pending | Exact request order/methods and upstream no-op success responses |
| GET_STATION_INFO | Implemented, differential pending | Nested owned song/artist seeds and thumbs-up/down feedback lists |
| SET_QUICKMIX, GET_GENRE_STATIONS, TRANSFORM_STATION | Implemented, differential pending | Exact array/auth ordering, owned genre/category lists and creator-state transition |
| EXPLAIN, BOOKMARK_SONG, BOOKMARK_ARTIST | Implemented, differential pending | Exact track-token request payloads, upstream text assembly and no-op bookmark success |
| GET_SETTINGS, CHANGE_SETTINGS | Pending | Settings ownership, tristates and optional members |
| GET_STATION_MODES, SET_STATION_MODE | Pending | Mode fields, active selection and response effects |

Unsupported successful response kinds must return `PIANO_RET_ERR`; server `stat: ok`
is never enough to call an unimplemented path complete.

## Implemented compatibility slices

Playlist uses exact upstream member ordering and json-c's historical spaced JSON
serialization before encryption. The response selects low/medium/high audio,
preserves ownership semantics, rejects unavailable requested quality, skips non-song
items, and builds lists with a tail pointer. Local GCC 14.2.0 strict-C99 tests covered
3 request and 12 response cases, a 255-byte wire oracle, 44 allocation-failure
positions, and Clang ASan/UBSan/leak checks.

Search emits `music.search` with `searchText`, `userAuthToken` and signed 32-bit
`syncTime`; results own artist and song lists. Station mutations implement exact
rename/delete/create method/member order and successful state changes, including
same-id replacement on create. Their pinned differentials remain unexecuted because
hosted jobs have not been assigned runners.

Feedback/rating follows upstream's high-level delegation: RATE_SONG temporarily
transforms its data into ADD_FEEDBACK, uses `station.addFeedback`, then restores
`req->type` and `req->data`. LOVE emits `isPositive:true`; BAN emits false.
Successful RATE_SONG responses update the song rating. ADD_TIRED_SONG emits
`user.sleepSong` and marks the song TIRED on success. Direct ADD_FEEDBACK success is
not exposed as successful behavior because upstream itself asserts there.

Seed mutations cover `station.addMusic`, `station.deleteFeedback` and
`station.deleteMusic`. ADD_SEED preserves upstream insertion order
`musicToken`, `stationToken`, then the shared authenticated tail. DELETE_SEED preserves
upstream seed-id precedence: song, then artist, then station. These three successful
response kinds are intentional no-ops, matching upstream's response dispatch rather
than inventing local state mutation.

GET_STATION_INFO emits `station.getStation` with the upstream member order:
`stationToken`, both extended/extra booleans, `userAuthToken`, then signed 32-bit
`syncTime`. Its response owns song seeds, artist seeds and feedback entries in
upstream order, including thumbs-up entries before thumbs-down entries, ratings and
track lengths. The historical `stationSeeds` field remains untouched because the
pinned upstream response path does not populate it. New data is built privately and
committed only after a successful parse, so malformed/OOM responses do not corrupt
pre-existing caller-owned station-info lists.

SET_QUICKMIX now serializes only stations with `useQuickMix` set while excluding the
QuickMix station itself, preserving list order and json-c's exact spaced array syntax.
GET_GENRE_STATIONS emits the shared authenticated body with no request-specific
members and parses owned category/genre lists in response order. New genre data is
built privately and appended only after a successful parse. TRANSFORM_STATION emits
`stationToken` first and sets `isCreator` only after an OK response. Local json-c 0.18
oracles matched 1,275 non-NUL byte-variant request bodies plus the empty QuickMix
array; full pinned response equivalence remains gated on an executing runner.

EXPLAIN, BOOKMARK_SONG and BOOKMARK_ARTIST all use the upstream `trackToken` first,
then the shared authenticated tail. Explain response text preserves the historical
768-byte bounded assembly and even the upstream one-element punctuation quirk caused
by unsigned `array_length - 2`; bookmarks intentionally ignore otherwise-OK response
bodies. Local strict-C99 syntax checks and a json-c 0.18 request-wire oracle matched
511 escaped/non-NUL byte cases. The text-assembly fixtures also matched a direct
reproduction of the pinned upstream algorithm.

The existing public ABI is unchanged. `piano.c` wraps hidden internal base
request/response symbols and intercepts only completeness slices added after that
base. Lowercase JSON control-escape hex matches json-c wire behavior; URL percent
escapes remain uppercase.

## Validation and infrastructure boundary

The pinned gate now runs `piano`, `playlist`, `search`, `station_mutations`,
`feedback`, `seed`, `station_info`, `quickmix_genre` and `explain_bookmarks` probes
against the same untouched reference archive. The most recent hosted differential was
explicitly retried before this slice and again terminated before setup with no recorded
steps and no assigned runner. Such runs are infrastructure failures, not source
verdicts.

Local QuickMix/genre work was checked with GCC 14.2.0 strict C99 and json-c 0.18. The
exact internal implementation body passed a strict translation-unit syntax check.
Independent json-c wire oracles matched 510 QuickMix byte-variant cases plus the empty
array and 765 genre/transform byte-variant cases. Commands, results and limitations are
retained in `docs/evidence/quickmix-genres-local-2026-09-14.txt`.

Local explanation/bookmark work was checked with GCC 14.2.0 strict C99 and json-c
0.18. The implementation/probe shapes passed strict syntax checks; the exact request
object matched 511 escaped/non-NUL byte variants, and explanation assembly matched the
upstream json-c algorithm for one-trait, sparse and three-trait fixtures. Details are
retained in `docs/evidence/explain-bookmarks-local-2026-09-14.txt`.

The parser intentionally rejects some malformed/coercible shapes that json-c may
tolerate. Escaped object keys, duplicate keys and all permissive json-c coercions are
not yet comprehensively matched. These remain explicit compatibility gaps.

## Performance and size evidence

The only retained full compatibility benchmark remains the same-host playlist run:
GCC 14.2.0 `-O2`, x86_64 AMD EPYC 9V74, no LTO or native-CPU flags. Median parse /
build / destroy throughput was 168,286 req/s for 4 songs, 10,669 for 64 songs and
2,506 for 256 songs. The comparable archive moved from 49,906 to 56,586 bytes when
playlist support was added. These are initial functionality measurements, not a
speedup ratio.

No search, station-mutation, feedback, seed-mutation, station-info, QuickMix/genre or
explanation/bookmark throughput/size movement is asserted until the real branch
executes. No new C/Odin/Zig/Nelua/Codin ranking is asserted. The native serializer
league keeps its existing five workloads and competitive gate: normalized geometric
mean >=90% of the leader and every workload >=80%. A C model is never evidence for
another language.

## Next acceptance slices

First obtain a completed pinned differential for the currently implemented slices.
Then implement settings, followed by station modes. Each slice must add identical
upstream/candidate probes before performance claims. Native-language protocol work
must remain independently implemented rather than routing every lane through C.
