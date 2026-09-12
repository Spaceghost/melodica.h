#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${ZIG:=zig}"
NELUA=${NELUA:-$(./tools/bootstrap-nelua.sh)}
OUT=build/language-bakeoff
mkdir -p "$OUT"

# Permanent core league: C99, Nelua, Zig native/C, and Odin native.
# Active challengers stay only while they have a credible path to competing.

"$ZIG" cc -std=c99 -O3 -DNDEBUG -Wall -Wextra -Werror -pedantic -Ilab \
  -c lab/c/find_string.c -o "$OUT/c.o"

NELUA_INIT="require('nelua.compactc').enable{static_asserts=false,export_declarations=false}" \
  "$NELUA" -r -c -o "$OUT/nelua.c" lab/nelua/find_string.nelua
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -c "$OUT/nelua.c" -o "$OUT/nelua.o"

"$ZIG" build-obj lab/zig/find_string.zig -OReleaseFast -ofmt=c \
  -femit-bin="$OUT/zig-c.c"
ZIG_EXE=$(readlink -f "$(command -v "$ZIG")")
ZIG_LIB_DIR="$(dirname "$ZIG_EXE")/lib"
test -f "$ZIG_LIB_DIR/zig.h"
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -I"$ZIG_LIB_DIR" \
  -c "$OUT/zig-c.c" -o "$OUT/zig-c.o"

"$ZIG" build-obj lab/zig/find_string.zig -OReleaseFast \
  -femit-bin="$OUT/zig-native.o"

odin build lab/odin -build-mode:lib -no-entry-point -o:speed -out:"$OUT/odin.a"

# Nim C backend. Keep its startup/runtime cost visible.
mkdir -p "$OUT/nimcache"
nim c --app:staticLib --noMain:on --mm:arc -d:danger --passC:-std=c99 \
  --nimcache:"$OUT/nimcache" -o:"$OUT/libnimlab.a" lab/nim/find_string.nim
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -c lab/nim/init.c -o "$OUT/nim-init.o"

# Gambit Scheme -> C. c-define exports a normal C function; the shim initializes
# the Scheme library once and then every timed call goes through the shared ABI.
# Gambit's own documentation notes that single-host C generation is faster, and
# that lower C optimization levels can outperform aggressive optimization on its
# generated C, so use that competitive configuration rather than a toy default.
GAMBIT_H=$(dpkg -L libgambit4-dev | grep '/gambit\.h$' | head -n1)
GAMBIT_INC=$(dirname "$GAMBIT_H")
GAMBIT_SO=$(ldconfig -p | awk '/libgambit\.so/{print $NF; exit}')
test -n "$GAMBIT_H"
test -n "$GAMBIT_SO"
GAMBIT_SO=$(readlink -f "$GAMBIT_SO")

gsc -:s -o "$OUT/gambit.c" -c lab/gambit/find_string.scm
gsc -:s -o "$OUT/gambitlink.c" -link "$OUT/gambit.c"
"$ZIG" cc -std=c99 -O1 -DNDEBUG -D___SINGLE_HOST -D_POSIX_C_SOURCE=200809L \
  -I"$GAMBIT_INC" -c "$OUT/gambit.c" -o "$OUT/gambit.o"
"$ZIG" cc -std=c99 -O1 -DNDEBUG -D___SINGLE_HOST -D_POSIX_C_SOURCE=200809L \
  -I"$GAMBIT_INC" -c "$OUT/gambitlink.c" -o "$OUT/gambitlink.o"
"$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab -I"$GAMBIT_INC" \
  -c lab/gambit/shim.c -o "$OUT/gambit-shim.o"

names=(c nelua zig-c zig-native odin nim gambit)
for name in "${names[@]}"; do
  extra_libs=()
  case "$name" in
    c)          inputs=("$OUT/c.o") ;;
    nelua)      inputs=("$OUT/nelua.o") ;;
    zig-c)      inputs=("$OUT/zig-c.o") ;;
    zig-native) inputs=("$OUT/zig-native.o") ;;
    odin)       inputs=("$OUT/odin.a") ;;
    nim)        inputs=("$OUT/nim-init.o" "$OUT/libnimlab.a") ;;
    gambit)
      inputs=("$OUT/gambit-shim.o" "$OUT/gambit.o" "$OUT/gambitlink.o")
      extra_libs=(-lgambit -lutil)
      ;;
  esac

  "$ZIG" cc -std=c99 -O2 -Ilab lab/conformance.c "${inputs[@]}" \
    -o "$OUT/test-$name" "${extra_libs[@]}" -lm -ldl -pthread
  "$OUT/test-$name" >/dev/null

  "$ZIG" cc -std=c99 -O3 -DNDEBUG -Ilab lab/bench.c "${inputs[@]}" \
    -o "$OUT/bench-$name" "${extra_libs[@]}" -lm -ldl -pthread
  : > "$OUT/times-$name.txt"
done

# Warm every implementation and then rotate trial order to spread runner noise.
for name in "${names[@]}"; do "$OUT/bench-$name" >/dev/null; done
for ((round=0; round<7; round++)); do
  for ((step=0; step<${#names[@]}; step++)); do
    idx=$(((round + step) % ${#names[@]}))
    name=${names[$idx]}
    "$OUT/bench-$name" >> "$OUT/times-$name.txt"
  done
done

printf 'language\tbackend\tns_per_lookup\tlookups_per_trial\tlinked_bytes\temitted_c_bytes\trelease_direct\n' > "$OUT/results.tsv"
for name in "${names[@]}"; do
  ns=$(sort -n "$OUT/times-$name.txt" | sed -n '4p')
  sample=1200000
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
    gambit)
      backend=scheme-to-c
      linked_bytes=$(( $(wc -c < "$OUT/gambit-shim.o") + $(wc -c < "$OUT/gambit.o") + $(wc -c < "$OUT/gambitlink.o") + $(wc -c < "$GAMBIT_SO") ))
      emitted_c_bytes=$(( $(wc -c < "$OUT/gambit.c") + $(wc -c < "$OUT/gambitlink.c") ))
      direct=no
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$backend" "$ns" "$sample" "$linked_bytes" "$emitted_c_bytes" "$direct" >> "$OUT/results.tsv"
done

winner=$(tail -n +2 "$OUT/results.tsv" | sort -t $'\t' -k3,3n | head -n1 | cut -f1)
cp "$OUT/results.tsv" lab/BENCHMARK.tsv
printf '%s\n' "$winner" > lab/WINNER
cat "$OUT/results.tsv"
echo "core language winner: $winner"
