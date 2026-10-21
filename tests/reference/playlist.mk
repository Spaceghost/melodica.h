# Compatibility tests have no language-toolchain dependency.
.PHONY: test-playlist test-playlist-alloc test-playlist-wire test-playlist-sanitize test-libpiano-sanitize test-libpiano-alloc test-json-oracle test-search bench-libpiano

test-libpiano: test-playlist test-search
$(BUILD)/compat/piano.o: compat/playlist.h compat/search.h

PLAYLIST_CFLAGS = -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror -Iinclude -Icompat
PLAYLIST_SOURCES = compat/piano.c compat/json.c compat/crypt.c compat/blowfish.c
PLAYLIST_HEADERS = include/piano.h compat/piano_base.inc $(wildcard compat/*.h) tests/reference/playlist_fixtures.h
PLAYLIST_WRAP = -DMELODICA_ALLOC_FAILURE_TEST -Wl,--wrap=malloc,--wrap=calloc,--wrap=realloc,--wrap=free

$(BUILD)/compat/playlist-probe: tests/reference/playlist_probe.c tests/reference/playlist_fixtures.h $(BUILD)/compat/libpiano.a
	$(CC) $(PLAYLIST_CFLAGS) $< $(BUILD)/compat/libpiano.a -o $@

$(BUILD)/compat/search-probe: tests/reference/search_probe.c $(BUILD)/compat/libpiano.a
	$(CC) $(PLAYLIST_CFLAGS) $< $(BUILD)/compat/libpiano.a -o $@

$(BUILD)/compat/playlist-safety: tests/playlist_safety.c tests/reference/playlist_fixtures.h $(BUILD)/compat/libpiano.a
	$(CC) $(PLAYLIST_CFLAGS) $< $(BUILD)/compat/libpiano.a -o $@

$(BUILD)/compat/playlist-alloc: tests/playlist_safety.c $(PLAYLIST_SOURCES) $(PLAYLIST_HEADERS)
	mkdir -p $(BUILD)/compat
	$(CC) $(PLAYLIST_CFLAGS) $(PLAYLIST_WRAP) $< $(PLAYLIST_SOURCES) -o $@

$(BUILD)/compat/playlist-wire: tests/reference/playlist_wire.c $(BUILD)/compat/libpiano.a
	$(CC) $(PLAYLIST_CFLAGS) $$(pkg-config --cflags json-c) $< $(BUILD)/compat/libpiano.a $$(pkg-config --libs json-c) -o $@

test-playlist: $(BUILD)/compat/playlist-probe $(BUILD)/compat/playlist-safety
	./$(BUILD)/compat/playlist-probe
	./$(BUILD)/compat/playlist-safety

test-search: $(BUILD)/compat/search-probe
	./$(BUILD)/compat/search-probe

test-playlist-alloc: $(BUILD)/compat/playlist-alloc
	./$(BUILD)/compat/playlist-alloc

$(BUILD)/compat/api-alloc: tests/compat_alloc.c $(PLAYLIST_SOURCES) $(PLAYLIST_HEADERS)
	mkdir -p $(BUILD)/compat
	$(CC) $(PLAYLIST_CFLAGS) $(PLAYLIST_WRAP) tests/compat_alloc.c $(PLAYLIST_SOURCES) -o $@

test-libpiano-alloc: test-playlist-alloc $(BUILD)/compat/api-alloc
	./$(BUILD)/compat/api-alloc

test-playlist-wire: $(BUILD)/compat/playlist-wire
	./$(BUILD)/compat/playlist-wire

$(BUILD)/compat/json-oracle: tests/json_oracle.c compat/json.c compat/json.h
	mkdir -p $(BUILD)/compat
	$(CC) $(PLAYLIST_CFLAGS) $$(pkg-config --cflags json-c) tests/json_oracle.c compat/json.c $$(pkg-config --libs json-c) -o $@

test-json-oracle: $(BUILD)/compat/json-oracle
	./$(BUILD)/compat/json-oracle

test-playlist-sanitize:
	mkdir -p $(BUILD)/sanitize
	$(CLANG) $(PLAYLIST_CFLAGS) -g -fsanitize=address,undefined -fno-omit-frame-pointer tests/reference/playlist_probe.c $(PLAYLIST_SOURCES) -o $(BUILD)/sanitize/playlist-probe
	ASAN_OPTIONS=detect_leaks=1 ./$(BUILD)/sanitize/playlist-probe
	$(CLANG) $(PLAYLIST_CFLAGS) -g -fsanitize=address,undefined -fno-omit-frame-pointer $(PLAYLIST_WRAP) tests/playlist_safety.c $(PLAYLIST_SOURCES) -o $(BUILD)/sanitize/playlist-alloc
	ASAN_OPTIONS=detect_leaks=1 ./$(BUILD)/sanitize/playlist-alloc

test-libpiano-sanitize: test-playlist-sanitize
	mkdir -p $(BUILD)/sanitize
	$(CLANG) $(PLAYLIST_CFLAGS) -g -fsanitize=address,undefined -fno-omit-frame-pointer $(PLAYLIST_WRAP) tests/compat_alloc.c $(PLAYLIST_SOURCES) -o $(BUILD)/sanitize/api-alloc
	ASAN_OPTIONS=detect_leaks=1 ./$(BUILD)/sanitize/api-alloc
	@set -eu; for probe in piano search station_mutations feedback seed station_info quickmix_genre explain_bookmarks settings station_modes coercion abi login; do \
		$(CLANG) $(PLAYLIST_CFLAGS) -g -fsanitize=address,undefined -fno-omit-frame-pointer tests/reference/$${probe}_probe.c $(PLAYLIST_SOURCES) -o $(BUILD)/sanitize/$$probe; \
		ASAN_OPTIONS=detect_leaks=1 ./$(BUILD)/sanitize/$$probe > $(BUILD)/sanitize/$$probe.txt; \
		printf '%s sanitizer: passed\n' "$$probe"; \
	done

bench-libpiano: $(BUILD)/compat/playlist-probe
	./$(BUILD)/compat/playlist-probe --bench
