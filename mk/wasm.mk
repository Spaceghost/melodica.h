# Freestanding wasm32 core: no WASI, Emscripten, allocator, or host imports.
# Trap any compiler-enabled UBSan checks (including Zig debug defaults) locally.
WASM_CC ?= $(CLANG)
WASM_TARGET ?= wasm32-unknown-unknown
WASM_CFLAGS ?= -O3
NODE ?= node

WASM_EXPORTS := melodica_abi_version \
	melodica_url_encode_size melodica_url_encode \
	melodica_json_escape_size melodica_json_escape \
	melodica_station_list_request_size melodica_station_list_request

.PHONY: wasm test-wasm wasm-example

wasm: $(BUILD)/wasm/melodica.wasm $(BUILD)/wasm/melodica.mjs

$(BUILD)/wasm/melodica.wasm: impl/c/melodica.c include/melodica.h mk/wasm.mk
	mkdir -p "$(@D)"
	$(WASM_CC) -target $(WASM_TARGET) $(WASM_CFLAGS) \
		-std=c99 -pedantic-errors -Wall -Wextra -Werror \
		-ffreestanding -fno-builtin -fsanitize-trap=all -nostdlib -Iinclude \
		-Wl,--no-entry -Wl,--export-memory -Wl,--export=__heap_base \
		-Wl,-z,stack-size=65536 -Wl,--initial-memory=131072 -Wl,--max-memory=16777216 \
		$(foreach symbol,$(WASM_EXPORTS),-Wl,--export=$(symbol)) $< -o "$@"

$(BUILD)/wasm/melodica.mjs: bindings/wasm/melodica.mjs
	mkdir -p "$(@D)"
	cp "$<" "$@"

test-wasm: wasm
	$(NODE) tests/wasm.mjs "$(BUILD)/wasm/melodica.wasm"

wasm-example: wasm $(BUILD)/wasm/index.html

$(BUILD)/wasm/index.html: examples/wasm/index.html
	mkdir -p "$(@D)"
	cp "$<" "$@"
