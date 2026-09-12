# Codin backend

Codin is tracked separately from the official Odin compiler because it is an independent Odin-to-C compiler implementation.

Pinned upstream: `graphitemaster/codin@2a3f71f65035a60943be40ffff7e031eec456aac`.

Current upstream status matters: the public `codin` binary presently exposes only `dump-ast`; there is not yet a usable C-emission command to feed into the shared `lab_find_string` benchmark. This directory therefore carries the actual lookup kernel in the Odin subset we want Codin to compile, and CI builds the pinned compiler and requires it to parse that kernel.

The promotion rule is simple: as soon as Codin can emit C for this kernel, `odin-codin` joins the same conformance and timing table as `odin` (official native backend), `zig-c`, `nelua`, and the other credible implementations. We do not manufacture benchmark numbers by hand-translating Codin's AST into C.

This is intentionally a compiler-development lane, not a permanent exemption from competition.
