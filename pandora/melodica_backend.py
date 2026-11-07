"""Load the pinned melodica.h adapter in both wheels and source trees."""

import sys
from pathlib import Path

try:
    from melodica import OfflineLibrary, StreamingCacheServer, dumps
except ImportError:  # pragma: no cover
    binding = (
        Path(__file__).resolve().parents[1]
        / "vendor/melodica.h/bindings/python"
    )
    sys.path.insert(0, str(binding))
    from melodica import OfflineLibrary, StreamingCacheServer, dumps

__all__ = ("OfflineLibrary", "StreamingCacheServer", "dumps")
