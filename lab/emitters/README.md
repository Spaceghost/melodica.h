# C99 emitter census

This directory answers a deliberately primitive first question before a language is allowed into the common-ABI benchmark:

> Can this particular compiler implementation emit C source that a C compiler accepts in C99 mode?

Each emitter has an independent CI job. A failure in one compiler does not hide the others. Passing the census does **not** make an implementation release material; it merely earns the right to implement the `lab_find_string` ABI and compete with C99/Nelua/Zig-C.

Current census probes:

- `spinel/` — Ruby through Matz's Spinel AOT compiler
- `nim/` — Nim's C backend
- `chicken/` — CHICKEN Scheme's Scheme-to-C translator
- `gambit/` — Gambit Scheme's portable-C compiler
- `vala/` — Vala's `-C` backend
- `ats/` — ATS2/Postiats through `patscc -ccats`

The distinction is intentionally about compiler implementations. CRuby is not a C emitter; Spinel is. Ordinary `rustc` is not a C emitter; a Rust C backend can be tested separately. Human language taxonomy is apparently insufficiently complicated, so compilers have volunteered to help.
