# C99 emitter census

This directory answers a deliberately primitive first question before a language is allowed into the common-ABI benchmark:

> Can this particular compiler implementation emit C source that a C compiler accepts in C99 mode?

Each emitter has an independent CI job. A failure in one compiler does not hide the others. Passing the census does **not** make an implementation release material; it merely earns the right to implement the `lab_find_string` ABI and compete with C99/Nelua/Zig-C/Nim.

Current census probes:

- `spinel/` — Ruby through Matz's Spinel AOT compiler
- `nim/` — Nim's C backend
- `chicken/` — CHICKEN Scheme's Scheme-to-C translator
- `gambit/` — Gambit Scheme's portable-C compiler
- `vala/` — Vala's `-C` backend
- `ats/` — ATS2/Postiats through `patscc -ccats`
- `v/` — V's C backend
- `cython/` — Cython's Python/Cython-to-C translator

The distinction is intentionally about compiler implementations. CRuby is not a C emitter; Spinel is. Ordinary `rustc` is not a C emitter; a Rust C backend can be tested separately. Runtime-heavy emitters remain useful experiments even when their generated C can never become the dependency-free shipped header.
