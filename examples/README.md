# Language consumers

Every example calls the same C99 release in `dist/melodica.h`. The implementation is compiled once from `bindings/melodica.c`; language examples link that object/static library instead of reimplementing protocol behavior.

Currently exercised in CI:

- C
- C++
- Zig
- Nelua
- Odin
- Objective-C
- Swift
- WASI compile target

This is intentional: `melodica.h` has one ABI and one implementation artifact. Bindings should remain thin enough that bugs cannot hide in a second parser written for a fashionable language.
