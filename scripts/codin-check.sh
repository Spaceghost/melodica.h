#!/bin/sh
set -eux

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${MELODICA_CACHE:-"$ROOT/.cache"}
CODIN_DIR="$CACHE/codin"
CODIN_COMMIT=2a3f71f65035a60943be40ffff7e031eec456aac
OVERLAY="$ROOT/tools/codin-overlay/src"
OUTDIR="$ROOT/build/codin"

mkdir -p "$CACHE" "$OUTDIR"

if [ ! -d "$CODIN_DIR/.git" ]; then
    git clone --filter=blob:none https://github.com/graphitemaster/codin.git "$CODIN_DIR"
fi

git -C "$CODIN_DIR" fetch --depth=1 origin "$CODIN_COMMIT"
git -C "$CODIN_DIR" checkout --detach "$CODIN_COMMIT"
git -C "$CODIN_DIR" reset --hard "$CODIN_COMMIT"

# Overlay the backend as a reproducible patch-stack until Spaceghost/codin can
# be created. Every file here is intended to move verbatim into that fork.
cp "$OVERLAY"/*.c "$CODIN_DIR/src/"
cp "$OVERLAY"/*.h "$CODIN_DIR/src/"

make -C "$CODIN_DIR" clean >/dev/null 2>&1 || true
# Keep ASan on while the new backend is being brought up. Once this lane is
# boringly green we switch back to the release compiler for shootout timing.
make -C "$CODIN_DIR" DEBUG=1 ASAN=1

printf '%s\n' '=== codin: dump AST ==='
ASAN_OPTIONS=abort_on_error=1:detect_leaks=0 \
    "$CODIN_DIR/codin" dump-ast "$ROOT/impl/codin" > "$OUTDIR/ast.txt"

printf '%s\n' '=== codin: emit C99 ==='
ASAN_OPTIONS=abort_on_error=1:detect_leaks=0 \
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

printf '%s\n' "codin C99 emission + GCC/Clang + ABI smoke: ok ($CODIN_COMMIT)"
