#!/bin/sh
# Build the actual pinned Codin parser with the protocol C99 lowering backend.
# Protocol behavior comes exclusively from impl/codin/piano/*.odin.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${MELODICA_CACHE:-"$ROOT/.cache"}
REV=555b5d6127e2f843ed4e015b40ece667052f1838
REFERENCE="$CACHE/codin-piano-reference-$REV"
case "${BUILD:-build}" in
    /*) OUT="${BUILD}/codin" ;;
    *) OUT="$ROOT/${BUILD:-build}/codin" ;;
esac
CC=${CC:-gcc}
CLANG=${CLANG:-clang}
mkdir -p "$CACHE" "$OUT"
if [ ! -d "$REFERENCE/.git" ]; then
    git init "$REFERENCE"
    git -C "$REFERENCE" remote add origin https://github.com/Spaceghost/codin.git
    git -C "$REFERENCE" fetch --depth=1 origin "$REV"
    git -C "$REFERENCE" checkout --detach FETCH_HEAD
fi
test "$(git -C "$REFERENCE" rev-parse HEAD)" = "$REV"
test -z "$(git -C "$REFERENCE" status --porcelain --untracked-files=no)"
WORK=$(mktemp -d "$CACHE/codin-piano-work.XXXXXX")
finish_work() {
    status=$?
    if [ "$status" -eq 0 ]; then
        rm -rf -- "$WORK"
    else
        printf 'Codin compiler scratch retained after failure: %s\n' "$WORK" >&2
    fi
}
trap finish_work EXIT
# Export the complete pinned tree: compatibility patches may also repair the
# experimental compiler tools. Archive excludes unrelated cache working files.
git -C "$REFERENCE" archive --format=tar "$REV" | tar -xf - -C "$WORK"
patch --batch --forward -d "$WORK" -p1 < "$ROOT/scripts/codin-compat.patch"
# The pinned parser otherwise drops positional compound initializer values.
patch --batch --forward -d "$WORK" -p1 < \
    "$REFERENCE/tools/c99-experimental/patches/0001-preserve-positional-compound-values.patch"
cp "$ROOT/scripts/codin-piano-c99.c" "$WORK/src/c99.c"
make -C "$WORK" -j2 CC="$CC"
cp "$WORK/codin" "$OUT/piano-codin"
"$OUT/piano-codin" emit-c "$ROOT/tests/codin/protocol_lowering" -o "$OUT/protocol-lowering.c"
for compiler in "$CC" "$CLANG"; do
    "$compiler" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -D_DEFAULT_SOURCE \
        "$ROOT/tests/codin/protocol_lowering_smoke.c" "$OUT/protocol-lowering.c" \
        -o "$OUT/protocol-lowering-smoke"
    "$OUT/protocol-lowering-smoke"
done
"$OUT/piano-codin" dump-ast "$ROOT/impl/codin/piano" > "$OUT/piano-ast.txt"
"$OUT/piano-codin" emit-c "$ROOT/impl/codin/piano" -o "$OUT/piano.c"
"$CC" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -D_DEFAULT_SOURCE \
    -c "$OUT/piano.c" -o "$OUT/piano.o"
"$CLANG" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -D_DEFAULT_SOURCE \
    -c "$OUT/piano.c" -o "$OUT/piano.clang.o"
ar rcs "$OUT/libpiano.a" "$OUT/piano.o"
sha256sum "$ROOT/scripts/codin-piano-c99.c" "$OUT/piano-codin" "$OUT/piano.c" \
    "$OUT/piano.o" "$OUT/piano.clang.o" "$OUT/libpiano.a" > "$OUT/piano-artifacts.sha256"
printf 'Codin protocol C99 compiled with GCC and Clang (parser %s)\n' "$REV"
