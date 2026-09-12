# Competitive implementation lab

This is the common-ABI challenger league for `melodica.h` implementation ideas. It is not a compiler museum.

## Permanent entries

- C99
- Nelua -> C99
- Zig native
- Zig -> C
- Odin native

## Active challengers

- Nim -> C
- Gambit Scheme -> C
- Spinel Ruby -> C (probation)
- Vala -> C (probation)

Every serious contender must implement the same `lab_find_string` ABI and pass the same malformed-JSON conformance cases. The shared C harness runs interleaved median-of-seven timing trials and records linked size and emitted-C size where applicable.

New implementations get one baseline attempt. They remain only if they are plausibly competitive on speed/size or reveal an optimization we can realistically transfer to a release candidate.

CHICKEN Scheme was removed after its first real common-ABI baseline landed around 42 us/lookup with roughly 7.5 MB of linked runtime. That measurement was useful; continuing to carry the implementation would not be.

A native Odin or Zig win does not become `dist/melodica.h` directly. It becomes the target for the dependency-free C99 release implementations to catch.
