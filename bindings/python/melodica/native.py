"""Small ctypes binding for melodica.h's portable ABI."""

import ctypes
import ctypes.util
import math
import os
from pathlib import Path


class NativeMelodica:
    """Load the melodica C ABI and expose its allocation-free serializers."""

    def __init__(self, library=None):
        candidates = []
        if library:
            candidates.append(library)
        if os.environ.get("MELODICA_LIBRARY"):
            candidates.append(os.environ["MELODICA_LIBRARY"])
        discovered = ctypes.util.find_library("melodica")
        if discovered:
            candidates.append(discovered)
        here = Path(__file__).resolve()
        candidates.extend(
            (
                here.parents[3] / "build" / "c" / "libmelodica.so",
                Path.home() / ".local/lib/libmelodica.so",
                Path("/usr/local/lib/libmelodica.so"),
                Path("/usr/lib/libmelodica.so"),
            )
        )

        error = None
        for candidate in candidates:
            try:
                self._lib = ctypes.CDLL(str(candidate))
                break
            except OSError as exc:
                error = exc
        else:
            raise RuntimeError(
                "melodica.h shared library not found; build it with `make shared` "
                "or set MELODICA_LIBRARY"
            ) from error

        self._lib.melodica_abi_version.restype = ctypes.c_uint32
        if self._lib.melodica_abi_version() != 1:
            raise RuntimeError("unsupported melodica.h ABI")

        for name in ("melodica_json_escape", "melodica_url_encode"):
            fn = getattr(self._lib, name)
            fn.argtypes = (
                ctypes.c_void_p,
                ctypes.c_size_t,
                ctypes.c_void_p,
                ctypes.c_size_t,
            )
            fn.restype = ctypes.c_size_t

    def _transform(self, name, value):
        source = value.encode("utf-8") if isinstance(value, str) else bytes(value)
        source_buffer = ctypes.create_string_buffer(source)
        fn = getattr(self._lib, name)
        needed = fn(None, 0, source_buffer, len(source))
        output = ctypes.create_string_buffer(needed)
        written = fn(output, needed, source_buffer, len(source))
        return output.raw[:written].decode("utf-8")

    def json_escape(self, value):
        return self._transform("melodica_json_escape", value)

    def url_encode(self, value):
        return self._transform("melodica_url_encode", value)


_NATIVE = None


def _native():
    global _NATIVE
    if _NATIVE is None:
        _NATIVE = NativeMelodica()
    return _NATIVE


def dumps(value):
    """Serialize the Pandora JSON subset using melodica.h for every string."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return '"{}"'.format(_native().json_escape(value))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite floats are not valid Pandora JSON")
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[{}]".format(",".join(dumps(item) for item in value))
    if isinstance(value, dict):
        return "{{{}}}".format(
            ",".join(
                "{}:{}".format(dumps(str(key)), dumps(item))
                for key, item in value.items()
            )
        )
    raise TypeError("unsupported JSON value: {}".format(type(value).__name__))
