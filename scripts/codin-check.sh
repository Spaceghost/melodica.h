#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${MELODICA_CACHE:-"$ROOT/.cache"}
CODIN_DIR="$CACHE/codin"
CODIN_COMMIT=2a3f71f65035a60943be40ffff7e031eec456aac

mkdir -p "$CACHE"

if [ ! -d "$CODIN_DIR/.git" ]; then
    git clone --filter=blob:none https://github.com/graphitemaster/codin.git "$CODIN_DIR"
fi

git -C "$CODIN_DIR" fetch --depth=1 origin "$CODIN_COMMIT"
git -C "$CODIN_DIR" checkout --detach "$CODIN_COMMIT"
git -C "$CODIN_DIR" reset --hard "$CODIN_COMMIT"

# Upstream's dump-ast command currently parses the tree but has the actual
# dump call commented out. Turn it back on in our pinned working copy so the
# shootout doubles as an executable specification for the C99 lowering work.
sed -i 's@// dump(work->tree);@dump(work->tree);@' "$CODIN_DIR/src/main.c"

make -C "$CODIN_DIR" clean >/dev/null 2>&1 || true
make -C "$CODIN_DIR"

"$CODIN_DIR/codin" dump-ast "$ROOT/impl/codin"

printf '%s\n' "codin parser + AST check: ok ($CODIN_COMMIT)"
