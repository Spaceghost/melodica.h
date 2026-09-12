#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CACHE="$ROOT/.cache/codin"
REV=2a3f71f65035a60943be40ffff7e031eec456aac

if [[ ! -x "$CACHE/codin" ]] || [[ ! -f "$CACHE/.melodica-rev" ]] || [[ "$(cat "$CACHE/.melodica-rev")" != "$REV" ]]; then
  rm -rf "$CACHE"
  git clone -q https://github.com/graphitemaster/codin.git "$CACHE"
  git -C "$CACHE" checkout -q "$REV"
  make -C "$CACHE" -j2
  printf '%s\n' "$REV" > "$CACHE/.melodica-rev"
fi

printf '%s\n' "$CACHE/codin"
