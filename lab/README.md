# Source-language lab

This is the challenger league for implementation languages, separate from the release parser bake-off.

There are deliberately **two lanes**.

## Core language league

C, Nelua, Zig, Odin, and selected useful emitters implement the same `lab_find_string` C ABI and pass the same malformed-JSON conformance cases. The core league is allowed to compare both native and C-emitting backends because its job is to find the best implementation and algorithm, not to pretend every good idea already fits the release format.

Permanent core entries:

- C99
- Nelua -> C99
- Zig native
- Zig -> C
- Odin native

Nim is currently included as a C-emitting challenger as well.

The same C benchmark harness warms every candidate and runs interleaved median-of-seven trials. Results are committed to `lab/BENCHMARK.tsv`; the fastest candidate is written to `lab/WINNER`.

A native winner does **not** magically become `dist/melodica.h`. It becomes the implementation to study and port into a dependency-free C99 release candidate. That is intentional: Odin and native Zig are here to make the C-facing implementations better.

## C-emitter zoo

`emitters/` tests more exotic source-to-C systems independently: Spinel Ruby, Scheme compilers, Nim, V, Vala, ATS/Postiats, Cython, and whatever other strange compiler deserves to be thrown at the wall next.

The census proves that a compiler really emits C accepted by a C99-mode compiler. Runtime-heavy systems are welcome in the census even when they are obviously unsuitable for the shipped header. Useful ones can graduate into the common-ABI core league.

## Release rule

`dist/melodica.h` remains stricter than either lab lane: one small dependency-free C99 header, allocation-free in the hot protocol layer, gated by full conformance and sanitizer tests. The lab finds winners; the release bake-off decides what can actually ship.

See [`../C99_EMITTERS.md`](../C99_EMITTERS.md) and [`emitters/`](emitters/README.md).
