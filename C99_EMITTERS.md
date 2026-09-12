# Competitive implementation league

`melodica.h` ships as a dependency-free C99 single header, but the implementation league is broader. Only implementations with a plausible path to competitive speed or size remain in-tree.

## Permanent core competitors

- C99
- Nelua -> C99
- Zig native
- Zig -> C
- Odin native

## Active challengers

- Nim -> C
- Gambit Scheme -> C
- Spinel Ruby -> C (one-shot probation until it completes the common-ABI benchmark)
- Vala -> C (same probation rule)

Gambit is explicitly allowed because it is a serious optimizing Scheme-to-C compiler, including single-host C generation. It is measured behind the same ABI rather than granted a nostalgia exemption.

## Admission rule

There is no emitter museum. A new backend gets one serious baseline against the shared `lab_find_string` ABI. It stays only if at least one is true:

1. runtime performance is plausibly competitive with the leaders;
2. code/runtime size is unusually attractive;
3. it exposes an optimization or code-generation technique we can realistically port into a release candidate.

A backend that is merely interesting but obviously noncompetitive is removed. CHICKEN's first common-ABI baseline, roughly 42 us/lookup with about 7.5 MB of linked runtime, was useful evidence and then grounds for deletion.

## Release eligibility

Winning the league is not sufficient to ship. `dist/melodica.h` must remain dependency-free C99 with a small stable ABI, no mandatory language runtime, an allocation-free hot protocol path, warning-clean output, sanitizer/conformance gates, and competitive speed and size.

Native Odin or native Zig may win the implementation league; when they do, their algorithm becomes the target the C99 release candidates must catch.
