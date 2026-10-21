# Independent native protocol implementations. Unlike the portable C lane,
# these use json-c and libgcrypt directly and must link those dependencies.
PIANO_NATIVE_LIBS = $(BUILD)/odin/libpiano.a $(BUILD)/zig/libpiano.a $(BUILD)/nelua/libpiano.a $(BUILD)/codin/libpiano.a
PIANO_NATIVE_DEPS = $(shell pkg-config --libs json-c libgcrypt 2>/dev/null)

.PHONY: libpiano-odin libpiano-zig libpiano-nelua libpiano-codin libpiano-native test-native-libpiano

$(BUILD)/odin/libpiano.a: $(wildcard impl/odin/piano/*.odin)
	mkdir -p $(BUILD)/odin
	$(ODIN) build impl/odin/piano -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/zig/piano.o: impl/zig/piano.zig include/piano.h
	mkdir -p $(BUILD)/zig
	$(ZIG) build-obj $< -Iinclude -lc -O ReleaseFast -mcpu=baseline -fPIC -femit-bin=$@

$(BUILD)/zig/libpiano.a: $(BUILD)/zig/piano.o
	$(AR) rcs $@ $<

$(BUILD)/nelua/piano.o: impl/nelua/piano.nelua include/piano.h
	mkdir -p $(BUILD)/nelua
	$(NELUA) --release --object --cc="$(CC)" --cflags="-O2" -o $@ $<

$(BUILD)/nelua/libpiano.a: $(BUILD)/nelua/piano.o
	$(AR) rcs $@ $<

$(BUILD)/codin/libpiano.a: $(wildcard impl/codin/piano/*.odin) scripts/codin-piano-c99.c scripts/codin-piano-check.sh scripts/codin-compat.patch $(wildcard tests/codin/protocol_lowering/*.odin) tests/codin/protocol_lowering_smoke.c
	CC="$(CC)" CLANG="$(CLANG)" BUILD="$(BUILD)" sh scripts/codin-piano-check.sh

libpiano-odin: $(BUILD)/odin/libpiano.a
libpiano-zig: $(BUILD)/zig/libpiano.a
libpiano-nelua: $(BUILD)/nelua/libpiano.a
libpiano-codin: $(BUILD)/codin/libpiano.a
libpiano-native: $(PIANO_NATIVE_LIBS)

test-native-libpiano: libpiano-native
	BUILD_DIR="$(abspath $(BUILD))" python3 scripts/native-piano.py
