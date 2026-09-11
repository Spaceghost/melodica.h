# melodica.h design

## Non-negotiables

1. **C99 is the product.** Nelua is the authoring language; generated C is a first-class artifact.
2. **One header, no mandatory dependencies.** A consumer defines `MELODICA_IMPLEMENTATION` once.
3. **No allocation in the public core.** Callers provide buffers; parsed strings are slices into input.
4. **No transport policy.** The host owns TLS/HTTP, CSRF cookies, auth-token persistence, retries, and audio.
5. **Stable ABI beats clever internals.** Candidates may be radically different behind identical exported functions.
6. **Correctness gates performance.** Adversarial JSON fixtures must pass before timing counts.
7. **Generated output remains inspectable.** Compact means less compiler debris, not deliberately obfuscated C.
8. **The release header is target-neutral.** It must compile unchanged for materially different ABIs, including 32-bit WASM.
9. **Protocol claims need evidence.** New service-specific request shapes are added from observed/independently implemented modern REST behavior, not guessed from old libpiano names.

## SQLite-style source model

```text
modular Nelua source
       |
       v
Spaceghost/nelua-lang compact C profile
       |
       v
candidate .c files
       |
       v
amalgamation
       |
       v
candidate single headers
       |
       +--> conformance + sanitizers
       +--> benchmark
       +--> size measurements
       +--> cross-ABI compile
       |
       v
winner -> dist/melodica.h
```

`dist/melodica.h` is generated and committed. It is never the source of truth.

## Release scoring

A candidate is eligible only when all conformance tests pass under ASan/UBSan and normal optimized builds.

For eligible candidates, lower is better:

```text
score = 0.35 * generic_lookup_speed_ratio
      + 0.30 * whole_track_speed_ratio
      + 0.20 * object_size_ratio
      + 0.15 * header_size_ratio
```

Each ratio is relative to the best candidate in that measurement from the same run. Timing uses the median of seven trials.

The benchmark harness compiles the caller separately from the header implementation, warms every candidate before measurement, then rotates candidate order each round and alternates lookup/track order. This does not turn shared CI into a laboratory instrument, but it removes several avoidable sources of benchmark theater.

If a current winner exists, a challenger must beat it by at least **3%** to replace it. This prevents runner noise from turning release selection into a weather vane. A failing current winner is replaced immediately by the best passing candidate.

## Zero-copy views

`melodica_track_view` and `melodica_station_view` contain offsets and lengths into the caller's JSON buffer. They own no memory and perform no decoding copies. Their `present` bitmasks distinguish missing fields from fields whose valid values are zero or empty. The caller must keep the JSON buffer alive while using the slices.

Collection iteration uses a caller-owned `size_t cursor`. Initialize it to zero and repeatedly call `melodica_track_next` or `melodica_station_next`. The iterator finds the relevant array, walks balanced object braces while respecting JSON strings, parses one object, and rebases every returned slice to the original full response buffer. Nested objects and arrays require no allocation.

This representation is deliberately friendly to Swift `Data`, JavaScript/WASM linear memory, mmap'd data, embedded buffers, and ordinary C arrays without inventing a library allocator.

## ABI

The public ABI uses only C primitives, fixed records, and caller-owned pointers. Nelua imports the public record layouts from the hand-written declaration half of the amalgamation instead of emitting a second competing definition.

Status codes:

- `MELODICA_OK`
- `MELODICA_NOT_FOUND`
- `MELODICA_INVALID_JSON`
- `MELODICA_NO_SPACE`
- `MELODICA_BAD_ARGUMENT`
- `MELODICA_OVERFLOW`

JSON string lookup returns the byte offset and raw JSON byte length between quotes. It validates JSON escapes but intentionally does not allocate or unescape. Consumers can copy/unescape only when they actually need ownership.

### Generated ABI assertions

Ordinary Nelua output embeds ABI assertions for the machine that generated the C. That is excellent for native generated-C programs but wrong for our **single portable release source**: an x86-64 generation host would intentionally reject wasm32 before the compiler could prove the header itself portable.

The release profile therefore omits Nelua's host-ABI static assertions and instead compiles the exact winning header for every cross-ABI target in CI. We keep the code restricted to explicit C-compatible types so this tests the artifact we actually ship.

## Candidate philosophy

`scan` is the reference behavior and should stay boring.

`hash` is allowed additional arithmetic if it reduces expensive key comparisons on realistic large payloads.

`tiny` optimizes generated/source size and may use direct pattern search, but it must still reject escaped fake keys and malformed scalar values. Small wrong code is still wrong code, merely more efficiently disappointing.

`dispatch` keeps the generic lookup API but specializes the common whole-track path: one structural pass recognizes known keys by cheap length/first-byte dispatch followed by exact comparison. It exists because the bake-off showed that rescanning a realistic track once per desired field was several times slower. The extra source/object size still has to earn itself in the same weighted score as every other candidate.

Station parsing and collection iteration are currently shared code. If they become a meaningful hot path, candidates may specialize them too, but only under the same ABI and correctness gates.

## REST surface policy

The current modern request writers cover login, station listing, playlist fragments, thumbs feedback, tired-song, and narrative/explanation. Request construction is deterministic, caller-buffered, and JSON-escaped.

The library does not own cookies, authorization headers, CSRF handling, retry policy, account state, or endpoint discovery. Those vary by host and service behavior and belong above this header.

Old libpiano remains useful as a map of product concepts, not as proof that an old endpoint or request shape is still valid. Modern operations are added only when their current request fields and paths can be independently verified.

## Compiler fork policy

Changes to `Spaceghost/nelua-lang` should be narrow and generally useful for distributable generated-C libraries. We prefer measuring emitted bytes before adding compiler transformations. Public `cexport`/`codename` names must never be shortened.

Release generation uses the compact profile with host-ABI assertions disabled. Debug/development Nelua builds may retain them.

## CI behavior

Source changes on `master` trigger the bake-off. Generated `dist/**` promotion commits and documentation-only changes do not, avoiding recursive release runs. The exact pinned Nelua checkout/build is cached by the hash of `tools/bootstrap-nelua.sh`; changing the pin invalidates the cache automatically.
