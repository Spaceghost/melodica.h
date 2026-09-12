# melodica.h for Odin

This is a thin Odin ABI package for the generated C99 release. It contains no duplicate parser or protocol implementation.

Build `bindings/melodica.c` into `build/languages/libmelodica.a`, then import:

```odin
import m "../../bindings/odin"
```

Views are zero-copy. Keep the source JSON string alive while using `m.Slice` offsets and lengths. `m.slice_string(json, slice)` is a convenience view over that original string.

Odin also has a native implementation challenger under `lab/odin/`. That implementation competes directly with C, Nelua, and Zig in the core language bake-off; this binding package is only for consuming the released `melodica.h` ABI.
