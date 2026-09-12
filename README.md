# melodica.h

A small, fast reimplementation of the useful `libpianobar`/`libpiano` core, developed as competing implementations behind one C ABI.

The repo deliberately keeps implementations side-by-side. Correctness is mandatory; generated/native artifact size, runtime speed, portability, dependency weight, and how cleanly an implementation can become the eventual single-header `melodica.h` are compared in CI.

## Current lanes

| lane | source | build | winner-eligible? |
|---|---|---|---|
| Odin | `impl/odin` | native Odin static library | yes |
| Codin C99 | `impl/codin` | Codin AST → tiny sema → range IR → strict C99 → GCC/Clang | yes |
| Codin native control | `impl/codin` | native Odin static library | control only |

Upstream [graphitemaster/codin](https://github.com/graphitemaster/codin) stopped after parsing. The pinned upstream commit remains `2a3f71f65035a60943be40ffff7e031eec456aac`; `tools/codin-overlay/` is a reproducible patch stack implementing the missing backend until it can move verbatim into a writable `Spaceghost/codin` fork.

The first backend is deliberately narrow and honest. Unsupported Odin constructs fail compilation instead of silently generating suspicious C, a standard compiler feature apparently worth stating aloud.

### C99 pipeline

```text
impl/codin/*.odin
      ↓
Codin parser
      ↓
minimal symbol/type resolution (sema.c)
      ↓
normalized range-loop lowering (ir.c)
      ↓
strict C99 emitter (c99.c)
      ↓
GCC -std=c99 -pedantic-errors
Clang -std=c99 -pedantic-errors
      ↓
shared ABI smoke tests + benchmark
```

The first green C99 shootout produced 395.58 MiB/s for Codin-generated C via GCC versus 338.32 MiB/s for native Odin on the JSON-escape microbenchmark. Treat that as one runner and one tiny workload, not tablets from the mountain. The generated C also compiled cleanly with both GCC and Clang under `-pedantic-errors`.

## ABI seed

Both lanes implement the first protocol-oriented, allocation-free primitives:

- RFC 3986 percent encoding
- JSON string escaping
- ABI versioning

```sh
make test
make codin-check
make bench
```

CI pins Odin `dev-2026-09` by SHA-256 and pins Codin by commit. Every lane must remain compatible with `include/melodica.h`.
