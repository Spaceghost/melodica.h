#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${MELODICA_CACHE:-"$ROOT/.cache"}
CODIN_DIR="$CACHE/codin"
CODIN_REPO=https://github.com/Spaceghost/codin.git
CODIN_COMMIT=555b5d6127e2f843ed4e015b40ece667052f1838
OUTDIR="$ROOT/build/codin"
ODIN=${ODIN:-odin}
GCC=${GCC:-gcc}
CLANG=${CLANG:-clang}

mkdir -p "$CACHE" "$OUTDIR"

if [ ! -d "$CODIN_DIR/.git" ]; then
    git clone --filter=blob:none "$CODIN_REPO" "$CODIN_DIR"
else
    git -C "$CODIN_DIR" remote set-url origin "$CODIN_REPO"
fi

git -C "$CODIN_DIR" fetch --depth=1 origin "$CODIN_COMMIT"
git -C "$CODIN_DIR" checkout --detach "$CODIN_COMMIT"
git -C "$CODIN_DIR" reset --hard "$CODIN_COMMIT"
git -C "$CODIN_DIR" clean -fdx

patch --batch --forward -d "$CODIN_DIR" -p1 < "$ROOT/scripts/codin-compat.patch"
"$CODIN_DIR/scripts/build-experimental-c99.sh"

"$CODIN_DIR/codin" dump-ast "$ROOT/impl/codin" > "$OUTDIR/ast.txt"
if ! "$CODIN_DIR/codin" emit-c "$ROOT/impl/codin" -o "$OUTDIR/melodica.c"; then
    printf '%s\n' '=== Codin AST around decimal_size ===' >&2
    awk 'BEGIN{show=0; n=0} /ident '\''decimal_size'\''/{show=1; n=0} show{print > "/dev/stderr"; n++} show && n>45{exit}' "$OUTDIR/ast.txt"
    exit 1
fi
"$GCC" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/melodica.c" -o "$OUTDIR/melodica.gcc.o"
"$CLANG" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/melodica.c" -o "$OUTDIR/melodica.clang.o"
"$GCC" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -I"$ROOT/include" \
    "$ROOT/tests/smoke.c" "$OUTDIR/melodica.c" -o "$OUTDIR/smoke"
"$OUTDIR/smoke"
"$GCC" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -I"$ROOT/include" \
    "$ROOT/bench/bench.c" "$OUTDIR/melodica.c" -o "$OUTDIR/bench"

check_fixture() {
    name=$1
    "$ODIN" check "$ROOT/tests/codin/$name" -no-entry-point
    "$CODIN_DIR/codin" emit-c "$ROOT/tests/codin/$name" -o "$OUTDIR/$name.c"
    "$GCC" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/$name.c" -o "$OUTDIR/$name.gcc.o"
    "$CLANG" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 -c "$OUTDIR/$name.c" -o "$OUTDIR/$name.clang.o"
    "$GCC" -std=c99 -pedantic-errors -Wall -Wextra -Werror -O3 \
        "$ROOT/tests/codin/${name}_smoke.c" "$OUTDIR/$name.c" -o "$OUTDIR/$name-smoke"
    "$OUTDIR/$name-smoke"
}

for fixture in structs arrays enums slices_strings multiple_returns defers unions; do
    printf '=== codin C99: %s fixture ===\n' "$fixture"
    check_fixture "$fixture"
done

printf '%s\n' "codin fork strict C99 + ABI/struct/array/enum/slice/string/multiple-return/defer/union smoke: ok ($CODIN_COMMIT)"
