#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${ZIG:=zig}"
NELUA=${NELUA:-$(./tools/bootstrap-nelua.sh)}
OUT=build/language-bakeoff
mkdir -p "$OUT"

# Build every challenger for speed, all exposing lab_find_string with the C ABI.
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Wall -Wextra -Werror -pedantic -c lab/c/find_string.c -o "$OUT/c.o"

NELUA_INIT="require('nelua.compactc').enable{static_asserts=false,export_declarations=false}" \
  "$NELUA" -r -c -o "$OUT/nelua.c" lab/nelua/find_string.nelua
"$ZIG" cc -std=c99 -O3 -DNDEBUG -c "$OUT/nelua.c" -o "$OUT/nelua.o"

"$ZIG" build-obj lab/zig/find_string.zig -OReleaseFast -femit-bin="$OUT/zig.o"

odin build lab/odin -build-mode:lib -o:speed -out:"$OUT/odin.a"

names=(c nelua zig odin)
for name in "${names[@]}"; do
  obj="$OUT/$name.o"
  [[ "$name" == odin ]] && obj="$OUT/odin.a"
  "$ZIG" cc -std=c99 -O2 -Ilab lab/conformance.c "$obj" -o "$OUT/test-$name" -lm -ldl -pthread
  "$OUT/test-$name" >/dev/null
  "$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab lab/bench.c "$obj" -o "$OUT/bench-$name" -lm -ldl -pthread
  : > "$OUT/times-$name.txt"
done

# Warm first, then interleave seven trials.
for name in "${names[@]}"; do "$OUT/bench-$name" >/dev/null; done
for ((round=0; round<7; round++)); do
  for ((step=0; step<${#names[@]}; step++)); do
    idx=$(((round + step) % ${#names[@]}))
    name=${names[$idx]}
    "$OUT/bench-$name" >> "$OUT/times-$name.txt"
  done
done

printf 'language\tns_per_lookup\timplementation_bytes\n' > "$OUT/results.tsv"
for name in "${names[@]}"; do
  ns=$(sort -n "$OUT/times-$name.txt" | sed -n '4p')
  obj="$OUT/$name.o"
  [[ "$name" == odin ]] && obj="$OUT/odin.a"
  bytes=$(wc -c < "$obj" | tr -d ' ')
  printf '%s\t%s\t%s\n' "$name" "$ns" "$bytes" >> "$OUT/results.tsv"
done

winner=$(tail -n +2 "$OUT/results.tsv" | sort -t $'\t' -k2,2n | head -n1 | cut -f1)
cp "$OUT/results.tsv" lab/BENCHMARK.tsv
printf '%s\n' "$winner" > lab/WINNER
cat "$OUT/results.tsv"
echo "language winner: $winner"
