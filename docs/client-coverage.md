# Client integration inventory

All native integrations target `melodica.h` ABI version 1. The compatibility
`piano.h` is implemented by the same repository so libpiano callers and newer
FFI callers share one protocol implementation.

| Client mirror | Systems | Integration lane |
| --- | --- | --- |
| `Spaceghost/pianobar` | Linux, BSD, macOS | melodica compatibility libpiano; offline cache, library, previous |
| `Spaceghost/pithos` | Linux | Python binding/submodule; offline cache, library, previous/MPRIS |
| `Spaceghost/pydora` | Linux, macOS | Python binding/submodule; offline cache, library, previous |
| `Spaceghost/pianobar-windows` | Windows | melodica compatibility libpiano submodule |
| `Spaceghost/elpis-melodica` | Windows | native `melodica` DLL bridge; PandoraSharp migration lane |
| `Spaceghost/epimetheus` | Android, iOS, macOS, Web | native FFI initialization on mobile/desktop; Web currently uses a Dart stub |
| `Spaceghost/pandoroid` | Android (legacy) | JNI bridge and offline-library migration lane |
| `Spaceghost/xivpiano-melodica` | Windows/Dalamud | native DLL bridge and shared library/cache IPC lane |

The Epimetheus mirror is the primary mobile target because one codebase covers
both Android and iOS. Pandoroid remains covered as the legacy Android client;
it is not treated as the iOS implementation. New clients should consume the C
ABI directly rather than create another Pandora protocol implementation.

Epimetheus's `dev` revision `1a89b7ed9a8941a645a0207ac3d43c95f44fbce9`
selects `melodica_native_stub.dart` for Web, where initialization returns false.
Its native bridge checks the ABI version but does not yet replace the client's
protocol calls. Melodica's [standalone WASM build](wasm.md) provides a loadable
serializer module and JavaScript binding; client integration remains separate.
