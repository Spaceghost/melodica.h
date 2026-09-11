# Source-language C99 lab

This is the challenger league for implementation languages, separate from the release parser bake-off.

Admission is intentionally strict: a compiler implementation must emit C source, and that emitted source must compile in C99 mode. A native object with a C ABI does not qualify.

The current common-ABI competitors implement the same `lab_find_string` function and pass the same malformed-JSON conformance cases:

- C99
- Nelua
- Zig through `-ofmt=c`
- Nim through its C backend

The harness recompiles or C99-compiles generated sources, then benchmarks the resulting link inputs using the same C harness and interleaved median-of-seven trials. Results are committed to `lab/BENCHMARK.tsv` and the fastest implementation to `lab/WINNER`.

Nim demonstrates why compiler implementation and release eligibility are separate questions: its C backend is valid here, but its generated library carries Nim runtime support and startup. The lab measures that honestly; the shipped `melodica.h` remains dependency-free.

This is a compiler-implementation league, not a surface-language popularity contest. Ruby may enter through Spinel even though CRuby does not emit C; Rust may enter through a C-emitting backend even though ordinary `rustc` does not. Native-only Odin was removed for the same reason.

The lab does not directly promote arbitrary runtime-heavy generated C into `dist/melodica.h`. Release candidates must still satisfy the stricter single-header, dependency-free C99 constraints. The lab exists to discover useful source languages, compiler techniques, and algorithms worth porting into the release candidates.

See [`../C99_EMITTERS.md`](../C99_EMITTERS.md) and [`emitters/`](emitters/README.md).
