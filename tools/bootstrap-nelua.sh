#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CACHE="$ROOT/.cache/nelua-lang"
NELUA_COMMIT=bbdc6b4777da9af56a0ac8e7024288bd2179b8fa

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
