import 'dart:ffi';
import 'dart:io';

typedef _AbiVersionNative = Uint32 Function();
typedef _AbiVersionDart = int Function();

class MelodicaNative {
  static const int requiredAbi = 1;

  static bool initialize() {
    try {
      final DynamicLibrary library = Platform.isIOS
          ? DynamicLibrary.process()
          : DynamicLibrary.open(Platform.isWindows
              ? 'melodica.dll'
              : Platform.isMacOS
                  ? 'libmelodica.dylib'
                  : 'libmelodica.so');
      return library
              .lookupFunction<_AbiVersionNative, _AbiVersionDart>(
                  'melodica_abi_version')() ==
          requiredAbi;
    } catch (_) {
      return false;
    }
  }
}
