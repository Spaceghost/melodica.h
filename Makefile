ODIN ?= odin
CC ?= cc
AR ?= ar
CLANG ?= clang
BUILD ?= build
PREFIX ?= /usr/local
DESTDIR ?=
ODIN_FLAGS ?= -o:speed -reloc-mode:pic -no-entry-point

.PHONY: all c odin codin-native codin-check libpiano test test-c test-odin test-codin-native test-libpiano bench bench-c bench-odin bench-codin portable install clean

all: test

$(BUILD)/c/melodica.o: impl/c/melodica.c include/melodica.h
	mkdir -p $(BUILD)/c
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude -c $< -o $@

$(BUILD)/c/libmelodica.a: $(BUILD)/c/melodica.o
	$(AR) rcs $@ $<

$(BUILD)/odin/libmelodica.a: impl/odin/melodica.odin
	mkdir -p $(BUILD)/odin
	$(ODIN) build impl/odin -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/codin-native/libmelodica.a: impl/codin/melodica.odin
	mkdir -p $(BUILD)/codin-native
	$(ODIN) build impl/codin -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/compat/piano.o: compat/piano.c include/piano.h
	mkdir -p $(BUILD)/compat
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude -c $< -o $@

$(BUILD)/compat/libpiano.a: $(BUILD)/compat/piano.o
	$(AR) rcs $@ $<

$(BUILD)/c/smoke: tests/smoke.c include/melodica.h $(BUILD)/c/libmelodica.a
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude tests/smoke.c $(BUILD)/c/libmelodica.a -o $@

$(BUILD)/odin/smoke: tests/smoke.c include/melodica.h $(BUILD)/odin/libmelodica.a
	$(CC) -O2 -std=c11 -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/odin/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/codin-native/smoke: tests/smoke.c include/melodica.h $(BUILD)/codin-native/libmelodica.a
	$(CC) -O2 -std=c11 -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/codin-native/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/compat/smoke: tests/libpiano_compat.c include/piano.h $(BUILD)/compat/libpiano.a
	$(CC) -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude tests/libpiano_compat.c $(BUILD)/compat/libpiano.a -o $@

$(BUILD)/c/bench: bench/bench.c include/melodica.h $(BUILD)/c/libmelodica.a
	$(CC) -O3 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude bench/bench.c $(BUILD)/c/libmelodica.a -o $@

$(BUILD)/odin/bench: bench/bench.c include/melodica.h $(BUILD)/odin/libmelodica.a
	$(CC) -O3 -std=c11 -Wall -Wextra -Werror -Iinclude bench/bench.c \
		$(BUILD)/odin/libmelodica.a -lm -ldl -lpthread -o $@

c: $(BUILD)/c/libmelodica.a
odin: $(BUILD)/odin/libmelodica.a
codin-native: $(BUILD)/codin-native/libmelodica.a
libpiano: $(BUILD)/compat/libpiano.a

codin-check:
	./scripts/codin-check.sh

test-c: $(BUILD)/c/smoke
	./$(BUILD)/c/smoke

test-odin: $(BUILD)/odin/smoke
	./$(BUILD)/odin/smoke

test-codin-native: $(BUILD)/codin-native/smoke
	./$(BUILD)/codin-native/smoke

test-libpiano: $(BUILD)/compat/smoke
	./$(BUILD)/compat/smoke

test: test-c test-odin test-codin-native test-libpiano

bench-c: $(BUILD)/c/bench
	./$(BUILD)/c/bench

bench-odin: $(BUILD)/odin/bench
	./$(BUILD)/odin/bench

bench-codin: codin-check
	./$(BUILD)/codin/bench

bench: bench-c bench-odin bench-codin

portable:
	mkdir -p $(BUILD)/portable
	$(CC) -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/native.o
	$(CLANG) --target=wasm32 -std=c99 -pedantic-errors -Wall -Wextra -Werror -ffreestanding -Iinclude -c impl/c/melodica.c -o $(BUILD)/portable/wasm32.o

install: $(BUILD)/c/libmelodica.a $(BUILD)/compat/libpiano.a
	install -d $(DESTDIR)$(PREFIX)/include $(DESTDIR)$(PREFIX)/lib
	install -m 0644 include/melodica.h include/piano.h $(DESTDIR)$(PREFIX)/include/
	install -m 0644 $(BUILD)/c/libmelodica.a $(DESTDIR)$(PREFIX)/lib/libmelodica.a
	install -m 0644 $(BUILD)/compat/libpiano.a $(DESTDIR)$(PREFIX)/lib/libpiano.a

clean:
	rm -rf $(BUILD)
