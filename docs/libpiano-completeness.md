# libpiano completeness and shootout contract

## Reference and scope

Reference: `PromyLOPh/pianobar` commit
`ad5ec908de10479ecee7d7c0e1030d12146f8f16`, pinned in
`tests/reference/pianobar.rev`. The differential gate builds that source unmodified.
PR #1 merged the five native serializer lanes; those lanes are not yet five complete
libpiano implementations. Full API behavior remains a separate compatibility league.

## Request/response inventory

Twelve of the 24 public request kinds now have implementations on both sides of the
request/response boundary: LOGIN, GET_STATIONS, GET_PLAYLIST, SEARCH,
RENAME_STATION, DELETE_STATION, CREATE_STATION, RATE_SONG, ADD_TIRED_SONG,
ADD_SEED, DELETE_FEEDBACK and DELETE_SEED. `ADD_FEEDBACK` request construction is
implemented because RATE_SONG delegates to it, but a successful direct ADD_FEEDBACK
response is deliberately not counted: pinned upstream asserts in that response case,
and melodica returns `PIANO_RET_ERR` rather than inventing a successful contract.

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
| GET_STATION_INFO | Pending | Nested owned seeds and feedback lists |
| SET_QUICKMIX, GET_GENRE_STATIONS, TRANSFORM_STATION | Pending | Lists, genres and creator-state transitions |
| EXPLAIN, BOOKMARK_SONG, BOOKMARK_ARTIST | Pending | Text assembly and exact request payloads |
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

Seed mutations now cover `station.addMusic`, `station.deleteFeedback` and
`station.deleteMusic`. ADD_SEED preserves upstream insertion order
`musicToken`, `stationToken`, then the shared authenticated tail. DELETE_SEED preserves
upstream seed-id precedence: song, then artist, then station. These three successful
response kinds are intentional no-ops, matching upstream's response dispatch rather
than inventing local state mutation.

The existing public ABI is unchanged. `piano.c` wraps hidden internal base
request/response symbols and intercepts only completeness slices added after that
base. Lowercase JSON control-escape hex matches json-c wire behavior; URL percent
escapes remain uppercase.

## Validation and infrastructure boundary

The pinned gate now runs `piano`, `playlist`, `search`, `station_mutations`,
`feedback` and `seed` probes against the same untouched reference archive.
Differential run #40 was explicitly retried before the seed slice; the retry again
completed with `steps=null` and no logs. That remains pre-execution runner
infrastructure failure, not a source verdict.

Local seed work was checked where possible with GCC 14.2.0 strict C99 and json-c
0.18. The internal header integration stub and deterministic differential probe both
compiled cleanly. An independent json-c oracle matched 1,788 exact pre-encryption
request JSON cases across ADD_SEED, DELETE_FEEDBACK and DELETE_SEED, including all
non-NUL single-byte values in their payload fields and auth-token positions. Raw
results and limitations are retained in
`docs/evidence/seeds-local-2026-09-14.txt`.

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

No search, station-mutation, feedback or seed-mutation throughput/size movement is
asserted until the real branch executes. No new C/Odin/Zig/Nelua/Codin ranking is
asserted. The native serializer league keeps its existing five workloads and
competitive gate: normalized geometric mean >=90% of the leader and every workload
>=80%. A C model is never evidence for another language.

## Next acceptance slices

First obtain a completed pinned differential for the currently implemented slices.
Then implement GET_STATION_INFO ownership and nested seed/feedback parsing, followed
by QuickMix/genres, explanation/bookmarks, settings and station modes. Each slice
must add identical upstream/candidate probes before performance claims.
Native-language protocol work must remain independently implemented rather than
routing every lane through C.
