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

# Copy our backend verbatim. Only genuine upstream parser defects remain as
# textual patches; backend feature growth is applied with exact checked anchors.
cp "$OVERLAY"/*.c "$CODIN_DIR/src/"
cp "$OVERLAY"/*.h "$CODIN_DIR/src/"
patch --batch --forward -d "$CODIN_DIR" -p1 < \
    "$PATCHES/0001-preserve-positional-compound-values.patch"
python3 "$ROOT/tools/codin-overlay/augment_c99.py" "$CODIN_DIR/src/c99.c"

make -C "$CODIN_DIR" clean >/dev/null 2>&1 || true
make -C "$CODIN_DIR"

printf '%s\n' '=== codin: dump AST ==='
"$CODIN_DIR/codin" dump-ast "$ROOT/impl/codin" > "$OUTDIR/ast.txt"

printf '%s\n' '=== codin: emit C99 ==='
"$CODIN_DIR/codin" emit-c "$ROOT/impl/codin" -o "$OUTDIR/melodica.c"

printf '%s\n' '=== generated C99: GCC ==='
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/melodica.c" -o "$OUTDIR/melodica.gcc.o"
printf '%s\n' '=== generated C99: Clang ==='
clang -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/melodica.c" -o "$OUTDIR/melodica.clang.o"

printf '%s\n' '=== generated C99: ABI smoke ==='
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -I"$ROOT/include" "$ROOT/tests/smoke.c" "$OUTDIR/melodica.c" \
    -o "$OUTDIR/smoke"
"$OUTDIR/smoke"

printf '%s\n' '=== generated C99: benchmark build ==='
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -I"$ROOT/include" "$ROOT/bench/bench.c" "$OUTDIR/melodica.c" \
    -o "$OUTDIR/bench"

printf '%s\n' '=== codin C99: struct fixture ==='
odin check "$ROOT/tests/codin/structs" -no-entry-point
"$CODIN_DIR/codin" emit-c "$ROOT/tests/codin/structs" -o "$OUTDIR/structs.c"
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/structs.c" -o "$OUTDIR/structs.gcc.o"
clang -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/structs.c" -o "$OUTDIR/structs.clang.o"
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    "$ROOT/tests/codin/structs_smoke.c" "$OUTDIR/structs.c" \
    -o "$OUTDIR/structs-smoke"
"$OUTDIR/structs-smoke"

printf '%s\n' '=== codin C99: fixed-array fixture ==='
odin check "$ROOT/tests/codin/arrays" -no-entry-point
"$CODIN_DIR/codin" emit-c "$ROOT/tests/codin/arrays" -o "$OUTDIR/arrays.c"
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/arrays.c" -o "$OUTDIR/arrays.gcc.o"
clang -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/arrays.c" -o "$OUTDIR/arrays.clang.o"
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    "$ROOT/tests/codin/arrays_smoke.c" "$OUTDIR/arrays.c" \
    -o "$OUTDIR/arrays-smoke"
"$OUTDIR/arrays-smoke"

printf '%s\n' '=== codin C99: enum fixture ==='
odin check "$ROOT/tests/codin/enums" -no-entry-point
"$CODIN_DIR/codin" emit-c "$ROOT/tests/codin/enums" -o "$OUTDIR/enums.c"
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/enums.c" -o "$OUTDIR/enums.gcc.o"
clang -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    -c "$OUTDIR/enums.c" -o "$OUTDIR/enums.clang.o"
gcc -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
    "$ROOT/tests/codin/enums_smoke.c" "$OUTDIR/enums.c" \
    -o "$OUTDIR/enums-smoke"
"$OUTDIR/enums-smoke"

printf '%s\n' "codin release C99 emission + GCC/Clang + ABI/struct/array/enum smoke: ok ($CODIN_COMMIT)"
