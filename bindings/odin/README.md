# melodica.h for Odin

This is a thin Odin ABI package for the generated C99 release. It contains no parser or protocol implementation of its own.

Build `bindings/melodica.c` into `build/languages/libmelodica.a`, then import:

```odin
import m "../../bindings/odin"
```

Views are zero-copy. Keep the source JSON string alive while using `m.Slice` offsets and lengths. `m.slice_string(json, slice)` is a convenience view over that original string.

The CI consumer exercises `Login_View` layout and returned slice offsets against the same static library used by the other languages.
