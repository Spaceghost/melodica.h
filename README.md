# melodica.h

A small, fast reimplementation of the useful `libpianobar`/`libpiano` core, developed as competing implementations behind one C ABI.

The repo deliberately keeps the implementations side-by-side. Correctness is mandatory; generated/native artifact size, runtime speed, portability, dependency weight, and how cleanly an implementation can become the eventual single-header `melodica.h` are compared in CI.

## Current lanes

| lane | source | build today | winner-eligible? |
|---|---|---|---|
| Odin | `impl/odin` | native Odin static library | yes |
| Codin | `impl/codin` | Codin parser check + native Odin control build | **not yet** |

`impl/codin` is intentionally restricted to an Odin subset that the Codin front-end accepts. Upstream [graphitemaster/codin](https://github.com/graphitemaster/codin) describes itself as an Odin-to-C compiler, but its current public command surface only parses packages (`dump-ast`; the actual dump call is commented out) and does not emit C yet. We pin commit `2a3f71f65035a60943be40ffff7e031eec456aac` so that lane is honest and reproducible rather than awarding a trophy to imaginary code generation.

When Codin gains usable C emission, the same source becomes a real generated-C competitor and can enter the winner calculation.

## ABI seed

Both source lanes currently implement the first protocol-oriented, allocation-free primitives:

- RFC 3986 percent encoding
- JSON string escaping
- ABI versioning

These are deliberately boring building blocks. Boring is excellent here: they give every implementation an identical C-facing contract while the larger Pandora protocol/session/audio pieces are added.

```sh
make test
make codin-check
make bench
```

CI uses the pinned `dev-2026-09` Odin release and verifies its SHA-256 before building. Every lane must keep `include/melodica.h` compatible.
