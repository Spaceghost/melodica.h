#!/bin/sh
# Build dist/: melodica.wasm + melodica.js from melodica.h's libpiano compat
# sources plus the static web client. Needs emscripten (emcc) on PATH or an
# emsdk checkout at $EMSDK (default /opt/emsdk).
set -eu
cd "$(dirname "$0")/.."

VENDOR=vendor/melodica.h
if [ ! -f "$VENDOR/include/piano.h" ]; then
    echo "vendor/melodica.h is empty: run 'git submodule update --init'" >&2
    exit 1
fi

if ! command -v emcc >/dev/null 2>&1; then
    EMSDK_DIR="${EMSDK:-/opt/emsdk}"
    if [ -d "$EMSDK_DIR/upstream/emscripten" ]; then
        PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
        for d in "$EMSDK_DIR"/node/*/bin; do PATH="$d:$PATH"; done
        export PATH EMSDK="$EMSDK_DIR"
    fi
fi
command -v emcc >/dev/null 2>&1 || { echo "emcc not found" >&2; exit 1; }

VERSION="${MELODICA_WEB_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo 0.0.0)}"
VERSION="${VERSION#v}"

rm -rf dist
mkdir -p dist

EXPORTS='_mw_init,_mw_begin,_mw_continue,_mw_finish,_mw_free,_mw_version,_mw_logged_in,_mw_stations,_malloc,_free'
RUNTIME='ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8'

emcc -O2 -std=c99 -Wall -Wextra \
    -I"$VENDOR/include" -I"$VENDOR/compat" \
    src/piano_wasm.c \
    "$VENDOR/compat/piano.c" "$VENDOR/compat/json.c" \
    "$VENDOR/compat/crypt.c" "$VENDOR/compat/blowfish.c" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMelodica \
    -sENVIRONMENT=web,node \
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=262144 \
    -sFILESYSTEM=0 -sINVOKE_RUN=0 \
    -sEXPORTED_FUNCTIONS="[$EXPORTS]" \
    -sEXPORTED_RUNTIME_METHODS="[$RUNTIME]" \
    -o dist/melodica.js

cp web/index.html web/app.js web/app.css web/piano.js dist/
cp LICENSE dist/LICENSE
cp "$VENDOR/LICENSE.libpiano" dist/LICENSE.libpiano
cp "$VENDOR/THIRD_PARTY_NOTICES.md" dist/THIRD_PARTY_NOTICES.md
printf '%s\n' "$VERSION" > dist/VERSION
sed -i.bak "s/__MELODICA_WEB_VERSION__/$VERSION/g" dist/app.js dist/index.html && rm -f dist/*.bak

echo "built melodica-web $VERSION:"
ls -l dist
