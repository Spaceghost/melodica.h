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
make -C "$CODIN_DIR"

# Upstream Codin currently exposes parsing (misnamed dump-ast; dumping is
# commented out) but not C emission. Keeping this check green tells us exactly
# when our translator-friendly Odin subset stops being acceptable to Codin.
"$CODIN_DIR/codin" dump-ast "$ROOT/impl/codin"

printf '%s\n' "codin parser check: ok ($CODIN_COMMIT)"
