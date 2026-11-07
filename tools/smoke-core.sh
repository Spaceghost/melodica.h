#!/usr/bin/env bash
# The release smoke test: run the XivPiano.Core.dll out of the released plugin zip, headless, with the
# melodica native bridge, and (when XIVPIANO_API_HOST names one) against a Pandora-protocol test server.
#
#   tools/smoke-core.sh <plugin zip> <out dir>
#
# Writes <out dir>/smoke-core.json and smoke-core.txt (see tools/smoke/XivPiano.Smoke/Program.cs for
# the environment it reads and the exact meaning of ok). On Linux the bridge is this checkout's Linux
# build of the same bridge source (native/build/linux-x64/libxivpiano_melodica.so, built here if it is
# missing): the zip only ships the win-x64 DLL, which XivPiano.Core cannot load on Linux. With
# XIVPIANO_SMOKE_WINE=1 the harness is additionally published for win-x64 and run under Wine with the
# zip's own DLL, into <out dir>/wine/.
#
# Trust: on Linux XIVPIANO_CA_BUNDLE (a PEM file) is handed to XivPiano.Core's PandoraHttp, which then
# trusts only that CA. Under Wine the same custom-root chain cannot be built (Wine's crypt32 refuses
# it: observed on the bak runner), so the Wine run uses Wine's own root store, which imports the
# Ubuntu system store (/usr/local/share/ca-certificates + update-ca-certificates) when the prefix
# is made; the test server's CA has to be installed there and its name resolvable (/etc/hosts), and
# Wine's SChannel does not match IP-address certificates, so XIVPIANO_API_HOST must be a DNS name
# for that run. XIVPIANO_SMOKE_WINE_CA_BUNDLE=1 hands the bundle to the Wine run anyway (it fails).
# The bundle is also exported to the Wine run as SSL_CERT_FILE, which Wine's crypt32 reads when it
# fills a fresh prefix's root store.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ZIP="$(realpath "${1:?plugin zip}")"
OUT="$(mkdir -p "${2:?out dir}" && realpath "$2")"
BUILD="${XIVPIANO_NATIVE_BUILD:-$ROOT/native/build}"
RELEASE="$BUILD/smoke/release"
DOTNET="${DOTNET:-dotnet}"
PROJECT="$ROOT/tools/smoke/XivPiano.Smoke/XivPiano.Smoke.csproj"
ARTIFACTS="${XIVPIANO_ARTIFACTS:-$ROOT/../xiv-piano-build/artifacts}"

rm -rf "$RELEASE"
mkdir -p "$RELEASE"
unzip -q "$ZIP" -d "$RELEASE"
for f in XivPiano.dll XivPiano.Core.dll XivPiano.json runtimes/win-x64/native/xivpiano_melodica.dll; do
  [[ -f "$RELEASE/$f" ]] || { echo "error: $f is not in $ZIP" >&2; exit 1; }
done
python3 "$ROOT/tools/check-native-package.py" "$ZIP"

if [[ ! -f "$BUILD/linux-x64/libxivpiano_melodica.so" ]]; then
  XIVPIANO_NATIVE_BUILD="$BUILD" bash "$ROOT/tools/build-melodica.sh" --linux
fi

"$DOTNET" build "$PROJECT" -c Release -p:XivPianoRelease="$RELEASE" --nologo
BIN="$ARTIFACTS/bin/XivPiano.Smoke/release"
[[ -f "$BIN/XivPiano.Smoke.dll" ]] || { echo "error: harness build output not at $BIN" >&2; exit 1; }
cmp -s "$BIN/XivPiano.Core.dll" "$RELEASE/XivPiano.Core.dll" || { echo "error: the harness did not take XivPiano.Core.dll from the zip" >&2; exit 1; }

status=0
XIVPIANO_SMOKE_ZIP="$ZIP" XIVPIANO_SMOKE_RELEASE="$RELEASE" XIVPIANO_SMOKE_OUT="$OUT" \
XIVPIANO_SMOKE_PLATFORM="${XIVPIANO_SMOKE_PLATFORM:-core (headless, linux-x64, Linux build of the bridge)}" \
XIVPIANO_MELODICA_LIBRARY="$BUILD/linux-x64/libxivpiano_melodica.so" \
  "$DOTNET" "$BIN/XivPiano.Smoke.dll" || status=$?
echo "smoke-core (linux): exit $status"

if [[ "${XIVPIANO_SMOKE_WINE:-0}" == 1 ]]; then
  PUBLISH="$BUILD/smoke/win-x64"
  rm -rf "$PUBLISH"
  "$DOTNET" publish "$PROJECT" -c Release -r win-x64 --self-contained true -p:UseAppHost=true \
    -p:XivPianoRelease="$RELEASE" -o "$PUBLISH" --nologo
  mkdir -p "$PUBLISH/runtimes/win-x64/native" "$OUT/wine"
  cp "$RELEASE/runtimes/win-x64/native/xivpiano_melodica.dll" "$PUBLISH/runtimes/win-x64/native/"
  cmp -s "$PUBLISH/XivPiano.Core.dll" "$RELEASE/XivPiano.Core.dll"
  # Windows paths for the Windows process: Wine maps / to Z:.
  win() { printf 'Z:%s' "${1//\//\\}"; }
  wine_status=0
  XIVPIANO_SMOKE_ZIP="$(win "$ZIP")" XIVPIANO_SMOKE_RELEASE="$(win "$RELEASE")" XIVPIANO_SMOKE_OUT="$(win "$OUT/wine")" \
  XIVPIANO_SMOKE_PLATFORM="core (headless, win-x64 under Wine, released bridge DLL)" \
  XIVPIANO_CA_BUNDLE="$([[ "${XIVPIANO_SMOKE_WINE_CA_BUNDLE:-0}" == 1 && -n "${XIVPIANO_CA_BUNDLE:-}" ]] && win "$XIVPIANO_CA_BUNDLE" || true)" \
  XIVPIANO_MELODICA_LIBRARY= \
  SSL_CERT_FILE="${XIVPIANO_CA_BUNDLE:-${SSL_CERT_FILE:-}}" \
    bash "$ROOT/tools/run-wine-headless.sh" "$PUBLISH/XivPiano.Smoke.exe" || wine_status=$?
  echo "smoke-core (wine): exit $wine_status"
  [[ "${XIVPIANO_SMOKE_WINE_REQUIRED:-0}" == 1 && $wine_status -ne 0 ]] && status=$wine_status
fi
exit $status
