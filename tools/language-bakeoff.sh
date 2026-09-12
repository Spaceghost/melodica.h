#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${ZIG:=zig}"
NELUA=${NELUA:-$(./tools/bootstrap-nelua.sh)}
OUT=build/language-bakeoff
mkdir -p "$OUT"

# Core language league. The public release is still C99, but native Zig and
# Odin are intentionally allowed to compete here. If a native implementation
# wins, its algorithm becomes a target for the C99 release implementations.

# C99 baseline.
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Wall -Wextra -Werror -pedantic -Ilab \
  -c lab/c/find_string.c -o "$OUT/c.o"

# Nelua -> C -> C99 object.
NELUA_INIT="require('nelua.compactc').enable{static_asserts=false,export_declarations=false}" \
  "$NELUA" -r -c -o "$OUT/nelua.c" lab/nelua/find_string.nelua
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -c "$OUT/nelua.c" -o "$OUT/nelua.o"

# Zig, C backend.
"$ZIG" build-obj lab/zig/find_string.zig -OReleaseFast -ofmt=c \
  -femit-bin="$OUT/zig-c.c"
ZIG_EXE=$(readlink -f "$(command -v "$ZIG")")
ZIG_LIB_DIR="$(dirname "$ZIG_EXE")/lib"
test -f "$ZIG_LIB_DIR/zig.h"
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -I"$ZIG_LIB_DIR" \
  -c "$OUT/zig-c.c" -o "$OUT/zig-c.o"

# Zig, native backend. Same source and ABI, different backend.
"$ZIG" build-obj lab/zig/find_string.zig -OReleaseFast \
  -femit-bin="$OUT/zig-native.o"

# Odin, native backend.
odin build lab/odin -build-mode:lib -no-entry-point -o:speed -out:"$OUT/odin.a"

# Nim -> C -> static library.
mkdir -p "$OUT/nimcache"
nim c --app:staticLib --noMain:on --mm:arc -d:danger --passC:-std=c99 \
  --nimcache:"$OUT/nimcache" -o:"$OUT/libnimlab.a" lab/nim/find_string.nim
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -c lab/nim/init.c -o "$OUT/nim-init.o"

# CHICKEN Scheme -> C. Compile the generated unit in embedded mode, then use a
# tiny C99 shim to initialize the Scheme runtime once and expose lab_find_string.
CHICKEN_H=$(dpkg -L libchicken-dev | grep '/chicken\.h$' | head -n1)
CHICKEN_INC=$(dirname "$CHICKEN_H")
CHICKEN_A=$(dpkg -L libchicken-dev | grep '/libchicken\.a$' | head -n1)
test -n "$CHICKEN_A"
chicken lab/chicken/find_string.scm -output-file "$OUT/chicken.c"
"$ZIG" cc -std=c99 -O3 -DNDEBUG -DC_EMBEDDED -I"$CHICKEN_INC" \
  -c "$OUT/chicken.c" -o "$OUT/chicken.o"
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -I"$CHICKEN_INC" \
  -c lab/chicken/shim.c -o "$OUT/chicken-shim.o"

names=(c nelua zig-c zig-native odin nim chicken)
for name in "${names[@]}"; do
  case "$name" in
    c)          inputs=("$OUT/c.o") ;;
    nelua)      inputs=("$OUT/nelua.o") ;;
    zig-c)      inputs=("$OUT/zig-c.o") ;;
    zig-native) inputs=("$OUT/zig-native.o") ;;
    odin)       inputs=("$OUT/odin.a") ;;
    nim)        inputs=("$OUT/nim-init.o" "$OUT/libnimlab.a") ;;
    chicken)    inputs=("$OUT/chicken-shim.o" "$OUT/chicken.o" "$CHICKEN_A") ;;
  esac

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

printf 'language\tbackend\tns_per_lookup\tlinked_bytes\temitted_c_bytes\trelease_direct\n' > "$OUT/results.tsv"
for name in "${names[@]}"; do
  ns=$(sort -n "$OUT/times-$name.txt" | sed -n '4p')
  case "$name" in
    c)
      backend=c99
      linked_bytes=$(wc -c < "$OUT/c.o" | tr -d ' ')
      emitted_c_bytes=$(wc -c < lab/c/find_string.c | tr -d ' ')
      direct=yes
      ;;
    nelua)
      backend=c99-emitter
      linked_bytes=$(wc -c < "$OUT/nelua.o" | tr -d ' ')
      emitted_c_bytes=$(wc -c < "$OUT/nelua.c" | tr -d ' ')
      direct=yes
      ;;
    zig-c)
      backend=c99-emitter
      linked_bytes=$(wc -c < "$OUT/zig-c.o" | tr -d ' ')
      emitted_c_bytes=$(wc -c < "$OUT/zig-c.c" | tr -d ' ')
      direct=no
      ;;
    zig-native)
      backend=native
      linked_bytes=$(wc -c < "$OUT/zig-native.o" | tr -d ' ')
      emitted_c_bytes=0
      direct=no
      ;;
    odin)
      backend=native
      linked_bytes=$(wc -c < "$OUT/odin.a" | tr -d ' ')
      emitted_c_bytes=0
      direct=no
      ;;
    nim)
      backend=c-emitter
      linked_bytes=$(( $(wc -c < "$OUT/nim-init.o") + $(wc -c < "$OUT/libnimlab.a") ))
      emitted_c_bytes=$(find "$OUT/nimcache" -type f -name '*.c' -exec wc -c {} + | \
        awk '$2 != "total" {s += $1} END {print s + 0}')
      direct=no
      ;;
    chicken)
      backend=scheme-to-c-runtime
      linked_bytes=$(( $(wc -c < "$OUT/chicken-shim.o") + $(wc -c < "$OUT/chicken.o") + $(wc -c < "$CHICKEN_A") ))
      emitted_c_bytes=$(wc -c < "$OUT/chicken.c" | tr -d ' ')
      direct=no
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$backend" "$ns" "$linked_bytes" "$emitted_c_bytes" "$direct" >> "$OUT/results.tsv"
done

winner=$(tail -n +2 "$OUT/results.tsv" | sort -t $'\t' -k3,3n | head -n1 | cut -f1)
cp "$OUT/results.tsv" lab/BENCHMARK.tsv
printf '%s\n' "$winner" > lab/WINNER
cat "$OUT/results.tsv"
echo "core language winner: $winner"
