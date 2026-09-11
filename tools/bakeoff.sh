#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

: "${ZIG:=zig}"
command -v "$ZIG" >/dev/null || { echo "zig is required" >&2; exit 2; }
NELUA=${NELUA:-$(./tools/bootstrap-nelua.sh)}

mkdir -p build/c build/headers build/bin build/metrics dist
: > build/metrics/raw.tsv

candidates=(scan hash tiny)
for name in "${candidates[@]}"; do
  echo "==> generating $name"
  NELUA_INIT="require('nelua.compactc').enable()" \
    "$NELUA" -r -c -o "build/c/$name.c" "impl/$name/melodica.nelua"
  ./tools/amalgamate.sh "build/c/$name.c" "build/headers/$name.h"

  echo "==> conformance $name"
  "$ZIG" cc -std=c99 -O2 -Wall -Wextra -Werror -pedantic -I. \
    -DMELODICA_HEADER=\"build/headers/$name.h\" \
    tests/conformance.c -o "build/bin/test-$name"
  "build/bin/test-$name" >/dev/null

  "$ZIG" cc -std=c99 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -I. \
    -DMELODICA_HEADER=\"build/headers/$name.h\" \
    tests/conformance.c -o "build/bin/sanitize-$name"
  ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 \
    "build/bin/sanitize-$name" >/dev/null

  echo "==> benchmark $name"
  "$ZIG" cc -std=c99 -O3 -DNDEBUG -I. \
    -DMELODICA_HEADER=\"build/headers/$name.h\" \
    bench/bench.c -o "build/bin/bench-$name"
  : > "build/metrics/times-$name.txt"
  for _ in 1 2 3 4 5 6 7; do
    "build/bin/bench-$name" >> "build/metrics/times-$name.txt"
  done
  ns=$(sort -n "build/metrics/times-$name.txt" | sed -n '4p')

  "$ZIG" cc -std=c99 -Os -DNDEBUG -I. \
    -DMELODICA_HEADER=\"build/headers/$name.h\" \
    -c tests/size.c -o "build/metrics/$name.o"
  obj_bytes=$(wc -c < "build/metrics/$name.o" | tr -d ' ')
  header_bytes=$(wc -c < "build/headers/$name.h" | tr -d ' ')
  printf '%s\t%s\t%s\t%s\n' "$name" "$ns" "$obj_bytes" "$header_bytes" >> build/metrics/raw.tsv
done

# Normalize measurements and compute one comparable score. Correctness has
# already acted as a hard gate above.
awk -F '\t' '
  NR==1 { min_t=$2; min_o=$3; min_h=$4 }
  { if($2<min_t)min_t=$2; if($3<min_o)min_o=$3; if($4<min_h)min_h=$4; row[NR]=$0 }
  END {
    print "name\tns_per_lookup\tobject_bytes\theader_bytes\tscore"
    for(i=1;i<=NR;i++) {
      split(row[i],a,"\t")
      score=.65*(a[2]/min_t)+.20*(a[3]/min_o)+.15*(a[4]/min_h)
      printf "%s\t%s\t%s\t%s\t%.6f\n",a[1],a[2],a[3],a[4],score
    }
  }
' build/metrics/raw.tsv > build/metrics/results.tsv

best=$(tail -n +2 build/metrics/results.tsv | sort -t $'\t' -k5,5n | head -n1 | cut -f1)
best_score=$(awk -F '\t' -v n="$best" '$1==n {print $5}' build/metrics/results.tsv)
winner=$best

if [[ -f dist/WINNER ]]; then
  current=$(head -n1 dist/WINNER | tr -d '[:space:]')
  current_score=$(awk -F '\t' -v n="$current" '$1==n {print $5}' build/metrics/results.tsv)
  if [[ -n "$current_score" && "$current" != "$best" ]]; then
    # Challenger must be at least 3% better. CI timing noise is not architecture.
    promote=$(awk -v b="$best_score" -v c="$current_score" 'BEGIN {print (b <= c*0.97) ? "yes" : "no"}')
    if [[ "$promote" != yes ]]; then winner=$current; fi
  fi
fi

cp "build/headers/$winner.h" dist/melodica.h
printf '%s\n' "$winner" > dist/WINNER

# Make sure the winning implementation can at least be compiled by Zig's C99
# frontend for several libc/ABI targets without linking.
for target in x86_64-linux-musl aarch64-linux-musl x86_64-windows-gnu wasm32-wasi; do
  "$ZIG" cc -target "$target" -std=c99 -Os -I. \
    -DMELODICA_HEADER=\"dist/melodica.h\" \
    -c tests/size.c -o "build/metrics/cross-${target//\//_}.o"
done

# Public declarations should also be consumable from C++ even though the
# implementation itself intentionally remains C99.
"$ZIG" c++ -std=c++17 -I. -DMELODICA_HEADER=\"dist/melodica.h\" \
  -c tests/declarations.cpp -o build/metrics/declarations.o

cat build/metrics/results.tsv
echo "winner: $winner"
