# C99 emitter zoo and core language league

`melodica.h` is a C99 release artifact, but the implementation lab is intentionally broader. Good algorithms do not become less interesting because their first implementation came from Odin or native Zig.

## Two different questions

The project keeps these questions separate:

1. **Which implementation is best?** The core language league may use native or C-emitting backends.
2. **What can ship as `melodica.h`?** The release must still become a small dependency-free C99 single header.

That distinction lets Odin or native Zig win honestly without pretending their binary can be pasted into a header. A native winner becomes a target for the C99-emitting implementations to catch or port.

## Permanent core competitors

The common-ABI hot-path league always keeps at least:

- C99
- Nelua -> C99
- Zig native
- Zig C backend
- Odin native

Nim -> C and CHICKEN Scheme -> C have also graduated into the common-ABI league. Their runtime costs are measured rather than hidden. CHICKEN's first implementation deliberately copies the incoming byte spans into Scheme strings, making it a correctness baseline to optimize rather than a suspiciously flattering microbenchmark.

## C-emitter admission

The separate emitter census is stricter about its label: a compiler only counts as a C emitter after CI generates source and a C compiler accepts that generated translation unit in `-std=c99` mode. Support headers and normal platform feature macros are allowed; that does not make a runtime-heavy compiler release-eligible.

Compiler implementation matters more than surface language. For example:

- Ruby may enter through Matz's Spinel AOT compiler even though CRuby is not a C emitter.
- Scheme has several independent C-producing implementations, so CHICKEN and Gambit are tested separately.
- Zig is tested both natively and through its C backend.
- Rust can enter the emitter zoo through a C-producing backend such as `rustc_codegen_c`, independently of ordinary `rustc`.

## CI-proven C emitters

The census has demonstrated generated C accepted in C99 mode from:

- Nelua
- Zig C backend
- Spinel Ruby
- Nim
- V
- CHICKEN Scheme
- Gambit Scheme
- Vala
- ATS2/Postiats
- Cython

These are compiler/toolchain facts, not endorsements for the final header. Several require substantial runtimes; that is precisely why the census and release eligibility are separate.

## Next useful compiler families

Candidates worth proving next include:

- Bigloo Scheme
- Mercury C backends
- Idris 2 RefC
- Koka C backend
- Pallene (typed Lua -> C)
- `rustc_codegen_c` / other Rust-to-C implementations
- CRUNCH and other Scheme-to-C systems
- older research compilers such as Stalin Scheme when they can still be made reproducible

## Release eligibility

Passing the emitter census is not enough to ship. A direct release candidate must still satisfy the actual `melodica.h` constraints:

- dependency-free generated C99 implementation
- stable small C ABI
- no mandatory language runtime
- allocation-free hot protocol path
- warning-clean C99
- sanitizer and conformance gates
- competitive speed and header/object size

The zoo exists to discover ideas and embarrass the incumbent. The release remains boring on purpose.
