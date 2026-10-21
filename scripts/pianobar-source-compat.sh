#!/bin/sh
# Compile unchanged historical application objects against the public API.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CC=${CC:-cc}
BUILD_DIR=${BUILD_DIR:-"$ROOT/build"}
OUT="$BUILD_DIR/pianobar-source-evidence"
REV=$(cat "$ROOT/tests/reference/pianobar.rev")
REF="$BUILD_DIR/pianobar-reference-$REV"
case "$REV" in *[!0-9a-f]*|'') echo 'Invalid reference revision' >&2; exit 1;; esac
[ "${#REV}" -eq 40 ] || exit 1
mkdir -p "$OUT"
printf 'incomplete\n' > "$OUT/status.txt"
: > "$OUT/build.log"
finish() {
    status=$?
    if [ "$status" -ne 0 ]; then
        printf 'failed (exit %s)\n' "$status" > "$OUT/status.txt"
        [ ! -f "$OUT/build.log" ] || tail -n 40 "$OUT/build.log" >&2
    fi
}
trap finish EXIT
if [ ! -d "$REF/.git" ]; then
    git init "$REF"
    git -C "$REF" remote add origin https://github.com/PromyLOPh/pianobar.git
    git -C "$REF" fetch --depth=1 origin "$REV"
    git -C "$REF" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$REF" rev-parse HEAD)" = "$REV" ]
[ -z "$(git -C "$REF" status --porcelain --untracked-files=no)" ]
{
    printf 'reference=%s\n' "$REV"
    "$CC" --version
    uname -a
    [ ! -r /etc/os-release ] || cat /etc/os-release
    pkg-config --modversion ao libavcodec libavformat libavutil libavfilter libcurl json-c libgcrypt
    sha256sum "$ROOT/include/piano.h"
} > "$OUT/environment.txt"
set -- src/main.o src/debug.o src/settings.o src/terminal.o \
    src/ui_act.o src/ui.o src/ui_readline.o src/ui_dispatch.o
make -B -C "$REF" CC="$CC" LIBPIANO_INCLUDE="$ROOT/include" \
    CFLAGS='-O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE -DMELODICA_PIANO_LEGACY_GCRYPT' \
    "$@" > "$OUT/build.log" 2>&1
# The generated dependency graph proves the consumer used the replacement header.
python3 - "$REF/src/main.d" "$ROOT/include/piano.h" <<'PY'
from pathlib import Path
import sys
dependencies = Path(sys.argv[1]).read_text()
if sys.argv[2] not in dependencies:
    raise SystemExit('historical consumer did not include the replacement piano.h')
PY
[ -z "$(git -C "$REF" status --porcelain --untracked-files=no)" ]
for object in "$@"; do sha256sum "$REF/$object"; done > "$OUT/artifacts.sha256"
printf 'passed\n' > "$OUT/status.txt"
printf 'pianobar source compatibility: %s unchanged application objects compiled\n' "$#"
