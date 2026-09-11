# C99 examples

This directory is deliberately small now.

- `c/` consumes the released single-header library directly as C99.
- `nelua/` demonstrates the source language used by the release implementation and emits C before being linked.

Cross-language FFI examples were removed. This project is not trying to prove that every language can call a C function; it is comparing source languages and compiler implementations that can **produce C99-compatible C**.

Those experiments live in [`../lab/`](../lab/README.md), with the admission rule documented in [`../C99_EMITTERS.md`](../C99_EMITTERS.md).
