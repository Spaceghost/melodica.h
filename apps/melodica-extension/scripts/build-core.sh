#!/usr/bin/env bash
# Build core/melodica_core.nelua -> dist/core/melodica_core.wasm.
#
#   NELUA      path to Jack's Nelua fork's `nelua` (default: nelua on PATH)
#   CLANG      clang with the wasm32 backend and lld (default: clang)
#   OUT        output directory (default: build/core)
#
# Step 1 emits C for the wasm32-unknown-unknown target (Nelua must know the
# pointer size); step 2 compiles it freestanding with no libc and exports the
# mx_* symbols. Nothing else is linked, so `wasm-objdump`/the Node test can
# audit the import list (it must be empty).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
NELUA="${NELUA:-nelua}"
CLANG="${CLANG:-clang}"
OUT="${OUT:-$here/build/core}"
mkdir -p "$OUT"

"$NELUA" --cc "$CLANG" --target wasm32-unknown-unknown --print-code \
  -L "$here/core" "$here/core/melodica_core.nelua" > "$OUT/melodica_core.c"

"$CLANG" --target=wasm32-unknown-unknown -std=c11 -O2 \
  -nostdlib -ffreestanding -fno-builtin -fno-stack-protector \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-all \
  -Wl,--initial-memory=1048576 \
  -o "$OUT/melodica_core.wasm" "$OUT/melodica_core.c"

# Audit: only the exports we mean to publish, no imports at all.
node -e '
const fs = require("fs");
const m = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const imports = WebAssembly.Module.imports(m);
const exports = WebAssembly.Module.exports(m).map((e) => e.name).sort();
if (imports.length) { console.error("unexpected imports:", imports); process.exit(1); }
const want = ["memory","mx_abi","mx_alloc","mx_arena_capacity","mx_arena_used","mx_decrypt_hex","mx_encrypt","mx_envelope","mx_free","mx_hex_decode","mx_hex_encode","mx_init","mx_init_keys","mx_ready","mx_reset","mx_set_sync_offset","mx_sync_offset","mx_sync_parse","mx_sync_time","mx_version","mx_version_len"];
const extra = exports.filter((e) => !want.includes(e) && !e.startsWith("__"));
const missing = want.filter((e) => !exports.includes(e));
if (extra.length || missing.length) { console.error("exports differ", { extra, missing, exports }); process.exit(1); }
console.log(`melodica_core.wasm: ${fs.statSync(process.argv[1]).size} bytes, ${exports.length} exports, 0 imports`);
' "$OUT/melodica_core.wasm"
