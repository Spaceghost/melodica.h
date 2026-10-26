ODIN ?= odin
ZIG ?= zig
NELUA ?= nelua
CC ?= cc
AR ?= ar
CLANG ?= clang
BUILD ?= build
PREFIX ?= /usr/local
DESTDIR ?=
PIANO_IMPL ?= c
PIANO_INSTALL_LIB = $(BUILD)/$(if $(filter c,$(PIANO_IMPL)),compat,$(PIANO_IMPL))/libpiano.a
PIANO_INSTALL_DEPS = $(if $(filter c,$(PIANO_IMPL)),,-ljson-c -lgcrypt -lm -ldl -lpthread)
ODIN_FLAGS ?= -o:speed -microarch:generic -reloc-mode:pic -no-entry-point
NELUA_FLAGS ?= --release -P nogc --cflags=-O3

.PHONY: all c shared odin zig nelua codin-native codin-check libpiano test test-c test-odin test-zig test-nelua test-codin-native test-libpiano test-blowfish test-crypt test-json bench bench-c bench-odin bench-zig bench-nelua bench-codin shootout shootout-gate portable install clean
.PHONY: check test-install test-pianobar-source test-pianobar-integration

all: test

# Complete validation; each comparison builds first and then times serially.
check:
	@test "$(BUILD)" = build || { echo 'make check requires BUILD=build; individual API targets support custom BUILD paths' >&2; exit 64; }
	$(MAKE) test-blowfish test-crypt test-json test-libpiano test-libpiano-alloc test-json-oracle test-playlist-wire test-libpiano-sanitize portable libpiano-native test-pianobar-source
	python3 -m unittest discover -s tests -p 'test_ci*.py' -v
	python3 scripts/native-ci.py
	BUILD_DIR="$(abspath $(BUILD))" sh scripts/libpiano-differential.sh
	BUILD_DIR="$(abspath $(BUILD))" python3 scripts/native-piano.py
	$(MAKE) test-install

test-install: libpiano-native $(BUILD)/c/libmelodica.a $(BUILD)/compat/libpiano.a
	CC="$(CC)" BUILD="$(BUILD)" sh scripts/install-smoke.sh

test-pianobar-source:
	CC="$(CC)" BUILD_DIR="$(abspath $(BUILD))" sh scripts/pianobar-source-compat.sh

test-pianobar-integration:
	mkdir -p "$(abspath $(BUILD))"
	CC="$(CC)" WORK_DIR="$(abspath $(BUILD))/pianobar-integration" \
		EVIDENCE_DIR="$$(mktemp -d '$(abspath $(BUILD))/pianobar-integration-evidence.XXXXXXXX')" \
		sh scripts/pianobar-integration.sh

$(BUILD)/c/melodica.o: impl/c/melodica.c include/melodica.h
	mkdir -p $(BUILD)/c
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude -c $< -o $@

$(BUILD)/c/libmelodica.a: $(BUILD)/c/melodica.o
	$(AR) rcs $@ $<

$(BUILD)/c/libmelodica.so: impl/c/melodica.c include/melodica.h
	mkdir -p $(BUILD)/c
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -fPIC -shared -Iinclude $< -o $@

$(BUILD)/odin/libmelodica.a: impl/odin/melodica.odin
	mkdir -p $(BUILD)/odin
	$(ODIN) build impl/odin -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/zig/libmelodica.a: impl/zig/melodica.zig
	mkdir -p $(BUILD)/zig
	$(ZIG) build-lib $< -O ReleaseFast -mcpu=baseline -fPIC -femit-bin=$@

$(BUILD)/nelua/libmelodica.a: impl/nelua/melodica.nelua
	mkdir -p $(BUILD)/nelua
	$(NELUA) $(NELUA_FLAGS) --cc="$(CC)" -A -o $@ $<

$(BUILD)/codin-native/libmelodica.a: impl/codin/melodica.odin
	mkdir -p $(BUILD)/codin-native
	$(ODIN) build impl/codin -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/compat/blowfish.o: compat/blowfish.c compat/blowfish.h compat/blowfish_pi.h
	mkdir -p $(BUILD)/compat
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Icompat -c $< -o $@

$(BUILD)/compat/crypt.o: compat/crypt.c compat/crypt.h compat/blowfish.h
	mkdir -p $(BUILD)/compat
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Icompat -c $< -o $@

$(BUILD)/compat/json.o: compat/json.c compat/json.h
	mkdir -p $(BUILD)/compat
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Icompat -c $< -o $@

$(BUILD)/compat/piano.o: compat/piano.c compat/piano_base.inc compat/playlist.h compat/search.h compat/station_mutations.h compat/feedback.h compat/seeds.h compat/quickmix_genres.h compat/explain_bookmarks.h compat/settings.h compat/station_modes.h include/piano.h compat/blowfish.h compat/crypt.h compat/json.h
	mkdir -p $(BUILD)/compat
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude -Icompat -c $< -o $@

$(BUILD)/compat/libpiano.a: $(BUILD)/compat/piano.o $(BUILD)/compat/json.o $(BUILD)/compat/crypt.o $(BUILD)/compat/blowfish.o
	$(AR) rcs $@ $^

$(BUILD)/c/smoke: tests/smoke.c include/melodica.h $(BUILD)/c/libmelodica.a
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude tests/smoke.c $(BUILD)/c/libmelodica.a -o $@

$(BUILD)/odin/smoke: tests/smoke.c include/melodica.h $(BUILD)/odin/libmelodica.a
	$(CC) -O2 -std=c11 -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/odin/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/zig/smoke: tests/smoke.c include/melodica.h $(BUILD)/zig/libmelodica.a
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/zig/libmelodica.a -o $@

$(BUILD)/nelua/smoke: tests/smoke.c include/melodica.h $(BUILD)/nelua/libmelodica.a
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/nelua/libmelodica.a -o $@

$(BUILD)/codin-native/smoke: tests/smoke.c include/melodica.h $(BUILD)/codin-native/libmelodica.a
	$(CC) -O2 -std=c11 -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/codin-native/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/compat/smoke: tests/libpiano_compat.c include/piano.h compat/crypt.h compat/json.h $(BUILD)/compat/libpiano.a
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude -Icompat tests/libpiano_compat.c $(BUILD)/compat/libpiano.a -o $@

$(BUILD)/compat/blowfish-smoke: tests/blowfish.c compat/blowfish.h $(BUILD)/compat/blowfish.o
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Icompat tests/blowfish.c $(BUILD)/compat/blowfish.o -o $@

$(BUILD)/compat/crypt-smoke: tests/crypt.c compat/crypt.h compat/blowfish.h $(BUILD)/compat/crypt.o $(BUILD)/compat/blowfish.o
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Icompat tests/crypt.c $(BUILD)/compat/crypt.o $(BUILD)/compat/blowfish.o -o $@

$(BUILD)/compat/json-smoke: tests/json.c compat/json.h $(BUILD)/compat/json.o
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Icompat tests/json.c $(BUILD)/compat/json.o -o $@

$(BUILD)/c/bench: bench/bench.c include/melodica.h $(BUILD)/c/libmelodica.a
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude bench/bench.c $(BUILD)/c/libmelodica.a -o $@

$(BUILD)/odin/bench: bench/bench.c include/melodica.h $(BUILD)/odin/libmelodica.a
	$(CC) -O3 -std=c11 -Wall -Wextra -Werror -Iinclude bench/bench.c \
		$(BUILD)/odin/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/zig/bench: bench/bench.c include/melodica.h $(BUILD)/zig/libmelodica.a
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude bench/bench.c \
		$(BUILD)/zig/libmelodica.a -o $@

$(BUILD)/nelua/bench: bench/bench.c include/melodica.h $(BUILD)/nelua/libmelodica.a
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude bench/bench.c \
		$(BUILD)/nelua/libmelodica.a -o $@

c: $(BUILD)/c/libmelodica.a
shared: $(BUILD)/c/libmelodica.so
odin: $(BUILD)/odin/libmelodica.a
zig: $(BUILD)/zig/libmelodica.a
nelua: $(BUILD)/nelua/libmelodica.a
codin-native: $(BUILD)/codin-native/libmelodica.a
libpiano: $(BUILD)/compat/libpiano.a

codin-check:
	./scripts/codin-check.sh

test-c: $(BUILD)/c/smoke
	./$(BUILD)/c/smoke

test-odin: $(BUILD)/odin/smoke
	./$(BUILD)/odin/smoke

test-zig: $(BUILD)/zig/smoke
	./$(BUILD)/zig/smoke

test-nelua: $(BUILD)/nelua/smoke
	./$(BUILD)/nelua/smoke

test-codin-native: $(BUILD)/codin-native/smoke
	./$(BUILD)/codin-native/smoke

test-libpiano: $(BUILD)/compat/smoke
	./$(BUILD)/compat/smoke

test-blowfish: $(BUILD)/compat/blowfish-smoke
	./$(BUILD)/compat/blowfish-smoke

test-crypt: $(BUILD)/compat/crypt-smoke
	./$(BUILD)/compat/crypt-smoke

test-json: $(BUILD)/compat/json-smoke
	./$(BUILD)/compat/json-smoke

test: test-c test-odin test-zig test-nelua test-codin-native test-blowfish test-crypt test-json test-libpiano

bench-c: $(BUILD)/c/bench
	./$(BUILD)/c/bench

bench-odin: $(BUILD)/odin/bench
	./$(BUILD)/odin/bench

bench-zig: $(BUILD)/zig/bench
	./$(BUILD)/zig/bench

bench-nelua: $(BUILD)/nelua/bench
	./$(BUILD)/nelua/bench

bench-codin: codin-check
	./$(BUILD)/codin/bench

bench: bench-c bench-odin bench-zig bench-nelua bench-codin

shootout: $(BUILD)/c/bench $(BUILD)/odin/bench $(BUILD)/zig/bench $(BUILD)/nelua/bench codin-check
	sh ./scripts/shootout.sh

shootout-gate: $(BUILD)/c/bench $(BUILD)/odin/bench $(BUILD)/zig/bench $(BUILD)/nelua/bench codin-check
	SHOOTOUT_FLOOR=0.90 SHOOTOUT_WORST_FLOOR=0.80 sh ./scripts/shootout.sh

portable:
	mkdir -p $(BUILD)/portable
	$(CC) -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/native.o
	$(CLANG) --target=wasm32 -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/wasm32-clang.o
	$(ZIG) cc -target wasm32-freestanding -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/wasm32-zigcc.o
	$(ZIG) cc -target aarch64-linux-musl -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/aarch64-linux-musl.o
	$(ZIG) cc -target x86_64-windows-gnu -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/x86_64-windows-gnu.o

install: $(BUILD)/c/libmelodica.a $(PIANO_INSTALL_LIB)
	install -d $(DESTDIR)$(PREFIX)/include $(DESTDIR)$(PREFIX)/bin $(DESTDIR)$(PREFIX)/lib/pkgconfig $(DESTDIR)$(PREFIX)/share/licenses/melodica $(DESTDIR)$(PREFIX)/share/melodica/python
	install -m 0644 include/melodica.h include/piano.h $(DESTDIR)$(PREFIX)/include/
	install -m 0644 $(BUILD)/c/libmelodica.a $(DESTDIR)$(PREFIX)/lib/libmelodica.a
	install -m 0644 $(PIANO_INSTALL_LIB) $(DESTDIR)$(PREFIX)/lib/libpiano.a
	install -m 0644 LICENSE.libpiano $(DESTDIR)$(PREFIX)/share/licenses/melodica/
	cp -R bindings/python/melodica $(DESTDIR)$(PREFIX)/share/melodica/python/
	install -m 0755 scripts/melodica-sync $(DESTDIR)$(PREFIX)/bin/melodica-sync
	install -m 0755 scripts/melodica-library $(DESTDIR)$(PREFIX)/bin/melodica-library
	install -m 0755 scripts/melodica-cloud $(DESTDIR)$(PREFIX)/bin/melodica-cloud
	sed -e 's|@PREFIX@|$(PREFIX)|g' -e 's|@PRIVATE_LIBS@|$(PIANO_INSTALL_DEPS)|g' pkgconfig/piano.pc.in > $(DESTDIR)$(PREFIX)/lib/pkgconfig/piano.pc
	sed -e 's|@PREFIX@|$(PREFIX)|g' pkgconfig/melodica.pc.in > $(DESTDIR)$(PREFIX)/lib/pkgconfig/melodica.pc

clean:
	rm -rf $(BUILD)

include tests/reference/playlist.mk
include mk/native-piano.mk
