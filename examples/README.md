# Language consumers

Every example calls the same C99 release in `dist/melodica.h`. The implementation is compiled from `bindings/melodica.c`; language examples link that object/static library instead of reimplementing protocol behavior.

The native examples parse the same login response and verify `melodica_login_view` layout, present bits, offsets, lengths, and zero-copy slices. This deliberately tests more than symbol linkage.

Exercised in CI:

- C
- C++
- Zig
- Nelua
- Odin, via the reusable `bindings/odin` package
- Rust
- Go (cgo)
- Objective-C
- Swift
- WASI compile target

This is intentional: `melodica.h` has one ABI and one implementation artifact. Bindings stay thin enough that bugs cannot hide in a second parser written for a fashionable language.
