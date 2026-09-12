# Examples

The examples stay intentionally small and focused on the project's core languages.

- `c/` consumes the released single-header library directly as C99.
- `nelua/` demonstrates the primary C-emitting source language used by the release implementation.
- `zig/` consumes the same released C ABI from Zig.
- `odin/` consumes the released C ABI through the thin reusable `bindings/odin` package.

The comparative implementations themselves live under [`../lab/`](../lab/README.md): C, Nelua, Zig (native and C backend), Odin, and selected experimental C emitters compete behind one hot-path ABI.

Objective-C and C++ examples are intentionally absent. The point is implementation comparison, not collecting every language capable of saying `extern`.
