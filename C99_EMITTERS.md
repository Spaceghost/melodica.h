# C99 emitter league

`melodica.h` is a C99 artifact. Language experiments are useful only when their **compiler implementation emits C source that survives a fresh C99 compile**.

## Admission rule

A challenger must have a real source-to-C path. The generated translation unit is compiled again with `-std=c99`; a native-only backend does not qualify merely because it exposes a C ABI.

This rule is about the compiler implementation, not the surface language:

- Rust through ordinary `rustc` is out; a C-emitting backend such as `rustc_codegen_c` is eligible.
- Ruby through CRuby/YJIT is out; Matz's Spinel AOT compiler is eligible if its generated C passes the census.
- Zig is eligible only through `-ofmt=c`, never through a native Zig object.
- Odin is out until a C-output backend exists.
- Objective-C and C++ are out because the product is C99, not "things vaguely linkable with C".

Feature-test macros and compiler-supplied C support headers are allowed in the census when the emitted translation unit genuinely remains C99. They are measured as dependencies. The shipped release is stricter: one dependency-free C99 header, allocation-free in the hot protocol layer, gated by the full conformance suite.

## Active common-ABI competitors

These implement the same `lab_find_string` ABI, pass the same malformed-input tests, and are benchmarked through one C harness:

| implementation | ns/lookup | linked bytes | emitted C bytes | status |
| --- | ---: | ---: | ---: | --- |
| Nelua | 346 | 12,216 | 4,719 | current winner |
| Nim C backend | 420 | 46,348 | 92,245 | active; runtime-backed |
| Zig C backend | 441 | 24,368 | 37,838 | active; uses `zig.h` |
| handwritten C99 | 583 | 10,992 | 3,029 | baseline |

These figures are the latest committed median-of-seven run in `lab/BENCHMARK.tsv`; CI may update them as runners vary.

## CI-proven C99 emitters

These have already emitted C in GitHub Actions and had that output accepted by a fresh `-std=c99` compile:

- Nelua
- Zig C backend
- Nim C backend
- CHICKEN Scheme
- Gambit Scheme
- Vala
- ATS2/Postiats
- Cython

Passing this census earns the right to attempt the common ABI. It does **not** imply release suitability. Cython, for example, is interesting compiler evidence but hauling CPython into a single-header protocol library would be comic sabotage.

## Census in progress

- Spinel, Matz's Ruby AOT-to-C compiler. Its first emitted C was valid enough to reach the runtime headers; the current probe supplies the POSIX/GNU feature declarations that runtime expects while retaining `-std=c99`.
- V, using its documented C output mode followed by an independent C99 compile.

## Researched next candidates

These have documented C backends and are worth adding after the current census stabilizes:

- Mercury, including its high-level C grade
- Idris 2 RefC
- Koka's direct C backend
- `rustc_codegen_c` / Rustic for Rust-to-C
- Pallene, a typed Lua-family compiler whose normal compilation path goes through C
- Bigloo Scheme and CRUNCH
- older Scheme-to-C research compilers such as Stalin when reproducible on current runners

The point is not to collect language logos. A candidate stays only if current CI proves its actual source-to-C path. Runtime-heavy emitters may still reveal useful code-generation or algorithmic ideas, but only candidates that can satisfy the release ABI without dragging their runtime into `melodica.h` can become release material.
