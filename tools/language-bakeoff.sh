#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${ZIG:=zig}"
NELUA=${NELUA:-$(./tools/bootstrap-nelua.sh)}
OUT=build/language-bakeoff
mkdir -p "$OUT"

# C99 is both the baseline and the final gate for every emitted translation unit.
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Wall -Wextra -Werror -pedantic -Ilab \
  -c lab/c/find_string.c -o "$OUT/c.o"

# Nelua -> C -> C99 object.
NELUA_INIT="require('nelua.compactc').enable{static_asserts=false,export_declarations=false}" \
  "$NELUA" -r -c -o "$OUT/nelua.c" lab/nelua/find_string.nelua
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -c "$OUT/nelua.c" -o "$OUT/nelua.o"

# Zig is admitted only through its C backend. Recompile the generated source in
# C99 mode with only the compiler distribution's generated-C support header.
"$ZIG" build-obj lab/zig/find_string.zig -OReleaseFast -ofmt=c \
  -femit-bin="$OUT/zig.c"
ZIG_EXE=$(readlink -f "$(command -v "$ZIG")")
ZIG_LIB_DIR="$(dirname "$ZIG_EXE")/lib"
test -f "$ZIG_LIB_DIR/zig.h"
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -I"$ZIG_LIB_DIR" \
  -c "$OUT/zig.c" -o "$OUT/zig.o"

# Nim -> C -> static C library. Nim's C backend has a small runtime startup
# contract, kept behind a C99 shim so every challenger still exposes one ABI.
mkdir -p "$OUT/nimcache"
nim c --app:staticLib --mm:arc -d:danger --passC:-std=c99 \
  --nimcache:"$OUT/nimcache" -o:"$OUT/libnimlab.a" lab/nim/find_string.nim
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -c lab/nim/init.c -o "$OUT/nim-init.o"

names=(c nelua zig nim)
for name in "${names[@]}"; do
  if [[ "$name" == nim ]]; then
    inputs=("$OUT/nim-init.o" "$OUT/libnimlab.a")
  else
    inputs=("$OUT/$name.o")
  fi
  "$ZIG" cc -std=c99 -O2 -Ilab lab/conformance.c "${inputs[@]}" \
    -o "$OUT/test-$name" -lm -ldl -pthread
  "$OUT/test-$name" >/dev/null
  "$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab lab/bench.c "${inputs[@]}" \
    -o "$OUT/bench-$name" -lm -ldl -pthread
  : > "$OUT/times-$name.txt"
done

# Warm first, then interleave seven trials to reduce scheduler/thermal ordering bias.
for name in "${names[@]}"; do "$OUT/bench-$name" >/dev/null; done
for ((round=0; round<7; round++)); do
  for ((step=0; step<${#names[@]}; step++)); do
    idx=$(((round + step) % ${#names[@]}))
    name=${names[$idx]}
    "$OUT/bench-$name" >> "$OUT/times-$name.txt"
  done
done

printf 'language\tns_per_lookup\tlinked_bytes\temitted_c_bytes\n' > "$OUT/results.tsv"
for name in "${names[@]}"; do
  ns=$(sort -n "$OUT/times-$name.txt" | sed -n '4p')
  case "$name" in
    c)
      linked_bytes=$(wc -c < "$OUT/c.o" | tr -d ' ')
      emitted_c_bytes=$(wc -c < lab/c/find_string.c | tr -d ' ')
      ;;
    nelua|zig)
      linked_bytes=$(wc -c < "$OUT/$name.o" | tr -d ' ')
      emitted_c_bytes=$(wc -c < "$OUT/$name.c" | tr -d ' ')
      ;;
    nim)
      linked_bytes=$(( $(wc -c < "$OUT/nim-init.o") + $(wc -c < "$OUT/libnimlab.a") ))
      emitted_c_bytes=$(find "$OUT/nimcache" -type f -name '*.c' -exec wc -c {} + | \
        awk '$2 != "total" {s += $1} END {print s + 0}')
      ;;
  esac
  printf '%s\t%s\t%s\t%s\n' "$name" "$ns" "$linked_bytes" "$emitted_c_bytes" >> "$OUT/results.tsv"
done

winner=$(tail -n +2 "$OUT/results.tsv" | sort -t $'\t' -k2,2n | head -n1 | cut -f1)
cp "$OUT/results.tsv" lab/BENCHMARK.tsv
printf '%s\n' "$winner" > lab/WINNER
cat "$OUT/results.tsv"
echo "C99 emitter winner: $winner"
