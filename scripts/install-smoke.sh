#!/bin/sh
# Stage every protocol variant and compile a client using installed headers/pc.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CC=${CC:-cc}
BUILD=${BUILD:-build}
case "$BUILD" in /*) OUT="$BUILD/install-smoke";; *) OUT="$ROOT/$BUILD/install-smoke";; esac
mkdir -p "$OUT"
for lane in c odin zig nelua codin; do
    stage="$OUT/$lane"
    make -C "$ROOT" BUILD="$BUILD" PIANO_IMPL="$lane" PREFIX=/usr DESTDIR="$stage" install \
        > "$OUT/$lane-install.log" 2>&1
    PKG_CONFIG_LIBDIR="$stage/usr/lib/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$stage" \
        pkg-config --static --cflags --libs piano > "$OUT/$lane-flags.txt"
    # The compiler and pkg-config flags are intentionally split into arguments.
    # shellcheck disable=SC2046
    $CC -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror \
        "$ROOT/examples/compat-client.c" $(cat "$OUT/$lane-flags.txt") -o "$OUT/client-$lane"
    "$OUT/client-$lane" > "$OUT/$lane.txt"
    if [ "$lane" != c ]; then diff -u "$OUT/c.txt" "$OUT/$lane.txt"; fi
    printf '%s: installed public client passed\n' "$lane"
done
