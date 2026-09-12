# Competitive implementation lab

This is the common-ABI challenger league for `melodica.h` implementation ideas. It is not a compiler museum.

## Permanent entries

- C99
- Nelua -> C99
- Zig native
- Zig -> C
- Odin through the official native compiler

Codin is tracked separately under `lab/codin/`. It is an independent Odin-to-C compiler implementation, pinned and built in CI. Its current upstream CLI can parse our real lookup kernel but does not yet expose C emission, so it is not timed until it can produce the shared `lab_find_string` ABI artifact. At that point it joins as `odin-codin` rather than replacing official Odin.

## Active challengers

- Nim -> C
- Gambit Scheme -> C
- Spinel Ruby -> C (probation)
- Vala -> C (probation)

Every serious contender must implement the same `lab_find_string` ABI and pass the same malformed-JSON conformance cases. The shared C harness runs interleaved median-of-seven timing trials and records linked size and emitted-C size where applicable.

New implementations get one baseline attempt. They remain only if they are plausibly competitive on speed/size or reveal an optimization we can realistically transfer to a release candidate.

A native Odin or Zig win does not become `dist/melodica.h` directly. It becomes the target for the dependency-free C99 release implementations to catch.
