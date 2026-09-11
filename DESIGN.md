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
score = 0.65 * speed_ratio
      + 0.20 * object_size_ratio
      + 0.15 * header_size_ratio
```

Each ratio is relative to the best candidate in that measurement from the same run. Timing uses the median of repeated trials.

If a current winner exists, a challenger must beat it by at least **3%** to replace it. This prevents runner noise from turning release selection into a weather vane. A failing current winner is replaced immediately by the best passing candidate.

## ABI

The public ABI uses only C primitives and caller-owned pointers. Nelua records remain internal so generated type naming can change freely.

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

The release profile therefore omits Nelua's host-ABI static assertions and instead compiles the exact winning header for every cross-ABI target in CI. We keep the code restricted to explicit C-compatible types so this is a stronger test of the artifact we actually ship.

## Candidate philosophy

`scan` is the reference behavior and should stay boring.

`hash` is allowed additional arithmetic if it reduces expensive key comparisons on realistic large payloads.

`tiny` optimizes generated/source size and may use direct pattern search, but it must still reject escaped fake keys and malformed scalar values. Small wrong code is still wrong code, merely more efficiently disappointing.

## Compiler fork policy

Changes to `Spaceghost/nelua-lang` should be narrow and generally useful for distributable generated-C libraries. We prefer measuring emitted bytes before adding compiler transformations. Public `cexport`/`codename` names must never be shortened.

Release generation uses the compact profile with host-ABI assertions disabled. Debug/development Nelua builds may retain them.
