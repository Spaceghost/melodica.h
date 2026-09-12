# Competitive implementation league

`melodica.h` ships as a dependency-free C99 single header, but the implementation league is broader. Only implementations that have a plausible path to competitive speed/size remain in-tree.

## Permanent core competitors

These stay regardless of which backend currently wins:

- C99
- Nelua -> C99
- Zig native
- Zig -> C
- Odin native

## Active challengers

These have demonstrated enough promise to justify continued optimization:

- Nim -> C
- Gambit Scheme -> C
- Spinel Ruby -> C (probation until it completes the common-ABI benchmark)
- Vala -> C (probation until it completes the common-ABI benchmark)

Gambit is explicitly allowed even with its runtime because its compiler is designed around aggressive C generation and has optimization modes such as single-host compilation. It gets judged by the same common ABI and measurements as everything else.

## Admission rule

There is no longer a museum-style emitter census. A new compiler gets one serious baseline attempt against the shared `lab_find_string` ABI. It stays only when at least one of these is true:

1. runtime performance is plausibly competitive with the leaders;
2. code size/runtime cost is unusually attractive;
3. it exposes an optimization/code-generation technique we can realistically port into a release candidate.

A backend that is simply interesting but obviously noncompetitive is removed.

## Disqualified examples

CHICKEN Scheme's first real common-ABI result was roughly 42 us/lookup and about 7.5 MB of linked runtime for this tiny primitive. That is useful evidence, but not a continuing contender. Cython and other runtime-heavy emitters are likewise out unless a substantially different implementation makes them competitive.

## Release eligibility

Winning the implementation league still does not make an artifact shippable. `dist/melodica.h` must remain:

- dependency-free C99
- small stable C ABI
- no mandatory language runtime
- allocation-free on the hot protocol path
- warning-clean
- sanitizer/conformance clean
- competitive on speed and size

Native Odin or native Zig can win the league and thereby become the algorithm/codegen target that the C99 release implementations must catch.
