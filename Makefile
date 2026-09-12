ODIN ?= odin
CC ?= cc
BUILD ?= build
ODIN_FLAGS ?= -o:speed -reloc-mode:pic -no-entry-point

.PHONY: all odin codin-native codin-check test test-odin test-codin-native bench bench-odin clean

all: test

$(BUILD)/odin/libmelodica.a: impl/odin/melodica.odin
	mkdir -p $(BUILD)/odin
	$(ODIN) build impl/odin -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/codin-native/libmelodica.a: impl/codin/melodica.odin
	mkdir -p $(BUILD)/codin-native
	$(ODIN) build impl/codin -build-mode:static -out:$@ $(ODIN_FLAGS)

$(BUILD)/odin/smoke: tests/smoke.c include/melodica.h $(BUILD)/odin/libmelodica.a
	$(CC) -O2 -std=c11 -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/odin/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/codin-native/smoke: tests/smoke.c include/melodica.h $(BUILD)/codin-native/libmelodica.a
	$(CC) -O2 -std=c11 -Wall -Wextra -Werror -Iinclude tests/smoke.c \
		$(BUILD)/codin-native/libmelodica.a -lm -ldl -lpthread -o $@

$(BUILD)/odin/bench: bench/bench.c include/melodica.h $(BUILD)/odin/libmelodica.a
	$(CC) -O3 -std=c11 -Wall -Wextra -Werror -Iinclude bench/bench.c \
		$(BUILD)/odin/libmelodica.a -lm -ldl -lpthread -o $@

odin: $(BUILD)/odin/libmelodica.a

codin-native: $(BUILD)/codin-native/libmelodica.a

codin-check:
	./scripts/codin-check.sh

test-odin: $(BUILD)/odin/smoke
	./$(BUILD)/odin/smoke

test-codin-native: $(BUILD)/codin-native/smoke
	./$(BUILD)/codin-native/smoke

test: test-odin test-codin-native

bench-odin: $(BUILD)/odin/bench
	./$(BUILD)/odin/bench

bench: bench-odin

clean:
	rm -rf $(BUILD)
