#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 generated.c output.h" >&2
  exit 2
fi

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CFILE=$1
OUT=$2
TMP="${OUT}.tmp.$$"

mkdir -p "$(dirname "$OUT")"
{
  cat "$ROOT/include/melodica.h.head"
  cat "$CFILE"
  cat "$ROOT/include/melodica.h.tail"
} > "$TMP"

# Never churn the release artifact when generation is byte-identical.
if [[ -f "$OUT" ]] && cmp -s "$TMP" "$OUT"; then
  rm -f "$TMP"
else
  mv "$TMP" "$OUT"
fi
