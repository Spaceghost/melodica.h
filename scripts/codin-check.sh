#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${MELODICA_CACHE:-"$ROOT/.cache"}
CODIN_DIR="$CACHE/codin"
CODIN_COMMIT=2a3f71f65035a60943be40ffff7e031eec456aac
OVERLAY="$ROOT/tools/codin-overlay/src"
PATCHES="$ROOT/tools/codin-overlay/patches"
OUTDIR="$ROOT/build/codin"

mkdir -p "$CACHE" "$OUTDIR"

if [ ! -d "$CODIN_DIR/.git" ]; then
    git clone --filter=blob:none https://github.com/graphitemaster/codin.git "$CODIN_DIR"
fi

git -C "$CODIN_DIR" fetch --depth=1 origin "$CODIN_COMMIT"
git -C "$CODIN_DIR" checkout --detach "$CODIN_COMMIT"
git -C "$CODIN_DIR" reset --hard "$CODIN_COMMIT"

cp "$OVERLAY"/*.c "$CODIN_DIR/src/"
cp "$OVERLAY"/*.h "$CODIN_DIR/src/"
patch --batch --forward -d "$CODIN_DIR" -p1 < \
    "$PATCHES/0001-preserve-positional-compound-values.patch"
python3 "$ROOT/tools/codin-overlay/augment_c99.py" "$CODIN_DIR/src/c99.c"
python3 "$ROOT/tools/codin-overlay/augment_slice_string.py" "$CODIN_DIR/src/c99.c"

make -C "$CODIN_DIR" clean >/dev/null 2>&1 || true
make -C "$CODIN_DIR"

printf '%s\n' '=== codin: dump AST ==='
"$CODIN_DIR/codin" dump-ast "$ROOT/impl/codin" > "$OUTDIR/ast.txt"

printf '%s\n' '=== codin: emit C99 ==='
"$CODIN_DIR/codin" emit-c "$ROOT/impl/codin" -o "$OUTDIR/melodica.c"

gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/melodica.c" -o "$OUTDIR/melodica.gcc.o"
clang -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/melodica.c" -o "$OUTDIR/melodica.clang.o"

gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -I"$ROOT/include" \
    "$ROOT/tests/smoke.c" "$OUTDIR/melodica.c" -o "$OUTDIR/smoke"
"$OUTDIR/smoke"

gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -I"$ROOT/include" \
    "$ROOT/bench/bench.c" "$OUTDIR/melodica.c" -o "$OUTDIR/bench"

check_fixture() {
    name=$1
    odin check "$ROOT/tests/codin/$name" -no-entry-point
    "$CODIN_DIR/codin" emit-c "$ROOT/tests/codin/$name" -o "$OUTDIR/$name.c"
    gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/$name.c" -o "$OUTDIR/$name.gcc.o"
    clang -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/$name.c" -o "$OUTDIR/$name.clang.o"
    gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
        "$ROOT/tests/codin/${name}_smoke.c" "$OUTDIR/$name.c" -o "$OUTDIR/$name-smoke"
    "$OUTDIR/$name-smoke"
}

printf '%s\n' '=== codin C99: struct fixture ==='
check_fixture structs
printf '%s\n' '=== codin C99: fixed-array fixture ==='
check_fixture arrays
printf '%s\n' '=== codin C99: enum fixture ==='
check_fixture enums
printf '%s\n' '=== codin C99: slice/string fixture ==='
check_fixture slices_strings

printf '%s\n' "codin strict C99 + ABI/struct/array/enum/slice/string smoke: ok ($CODIN_COMMIT)"
