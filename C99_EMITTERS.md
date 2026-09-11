# C99 emitter league

`melodica.h` is a C99 artifact. Language experiments are useful only when their compiler implementation can emit C source that a C compiler can consume in C99 mode.

## Admission rule

A challenger must have a real source-to-C path. The generated translation unit is compiled again with `-std=c99`; a native-only backend does not qualify just because it can call C.

This rule is about the **compiler implementation**, not the surface language. A language may be represented by one compiler and rejected through another. For example:

- Rust through ordinary `rustc` is out; a C-emitting backend such as `rustc_codegen_c` is eligible.
- Ruby through CRuby/YJIT is out; Matz's Spinel AOT compiler is eligible because it emits C.
- Zig is eligible only through `-ofmt=c`, not through a native object build.
- Odin is out until it has a C-output backend.

The release itself remains stricter than the lab: one dependency-free C99 header, allocation-free in the hot protocol layer, and gated by the full conformance suite.

## Active common-ABI competitors

These implement the same `lab_find_string` ABI, emit C (or are C), and are benchmarked by the same C harness:

- C99
- Nelua
- Zig C backend

## C-emitting implementations to bring into the league

The next pool deliberately includes strange and alternate implementations where useful:

- Spinel (Ruby AOT to C)
- Nim C backend
- CHICKEN Scheme and CRUNCH (CRUNCH explicitly targets C99)
- Gambit Scheme
- Bigloo Scheme
- V C backend
- Vala
- ATS/Postiats
- Mercury C backends
- Idris 2 RefC
- Koka C backend
- Pallene (typed Lua to C)
- Cython where a standalone/library-shaped C artifact is practical
- `rustc_codegen_c` / Rustic as the Rust-to-C implementation
- older research compilers such as Stalin Scheme when they can still be made reproducible

A compiler stays on this list only after CI proves its current output path. Runtime-heavy emitters can still teach us code-generation ideas, but only candidates that can satisfy the `melodica.h` ABI without dragging a runtime into the shipped header can become release material.
