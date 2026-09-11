#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CACHE="$ROOT/.cache/nelua-lang"
NELUA_COMMIT=ac6a9b6d13cd1bcd22d8e8a1e4a8665066012532

if [[ -x "$CACHE/nelua" ]] && [[ "$(git -C "$CACHE" rev-parse HEAD 2>/dev/null || true)" == "$NELUA_COMMIT" ]]; then
  printf '%s\n' "$CACHE/nelua"
  exit 0
fi

rm -rf "$CACHE"
mkdir -p "$CACHE"
git -C "$CACHE" init -q
git -C "$CACHE" remote add origin https://github.com/Spaceghost/nelua-lang.git
git -C "$CACHE" fetch -q --depth=1 origin "$NELUA_COMMIT"
git -C "$CACHE" checkout -q --detach FETCH_HEAD
make -s -C "$CACHE"

printf '%s\n' "$CACHE/nelua"
