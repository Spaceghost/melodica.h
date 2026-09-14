#!/bin/sh
# Full API compatibility league, separate from the five serializer lanes.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CC=${CC:-cc}
BUILD_DIR=${BUILD_DIR:-"$ROOT/build"}
OUT="$BUILD_DIR/libpiano-evidence"
REV=$(cat "$ROOT/tests/reference/pianobar.rev")
REF="$BUILD_DIR/pianobar-reference-$REV"
mkdir -p "$OUT"
case "$REV" in *[!0-9a-f]*|'') echo 'Invalid reference revision' >&2; exit 1;; esac
[ "${#REV}" -eq 40 ] || exit 1

{
    printf 'reference=%s\n' "$REV"
    git -C "$ROOT" rev-parse HEAD
    "$CC" --version
    uname -a
    pkg-config --modversion json-c libgcrypt libcurl
    printf 'optimization=-O2; no LTO; no native-CPU tuning\n'
} > "$OUT/environment.txt"

if [ ! -d "$REF/.git" ]; then
    git init "$REF"
    git -C "$REF" remote add origin https://github.com/PromyLOPh/pianobar.git
    git -C "$REF" fetch --depth=1 origin "$REV"
    git -C "$REF" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$REF" rev-parse HEAD)" = "$REV" ] || {
    echo 'Reference checkout does not match pin; refusing to reset it' >&2; exit 1;
}
# Never patch the reference. A dirty checkout invalidates the comparison.
[ -z "$(git -C "$REF" status --porcelain --untracked-files=no)" ] || exit 1
make -B -C "$REF" CC="$CC" CFLAGS='-O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE' \
    src/libpiano/crypt.o src/libpiano/piano.o src/libpiano/request.o \
    src/libpiano/response.o src/libpiano/list.o
ar rcs "$OUT/libpiano-reference.a" \
    "$REF/src/libpiano/crypt.o" "$REF/src/libpiano/piano.o" \
    "$REF/src/libpiano/request.o" "$REF/src/libpiano/response.o" "$REF/src/libpiano/list.o"
# Rebuild both sides rather than benchmarking stale objects from other flags.
make -B -C "$ROOT" CC="$CC" BUILD="$BUILD_DIR" libpiano
for probe in piano playlist search station_mutations feedback seed station_info quickmix_genre; do
    "$CC" -O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE -DMELODICA_REFERENCE_UPSTREAM \
        -I"$REF/src/libpiano" "$ROOT/tests/reference/${probe}_probe.c" \
        "$OUT/libpiano-reference.a" $(pkg-config --libs libcurl libgcrypt json-c) -lm -lpthread \
        -o "$OUT/$probe-reference"
    "$CC" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror \
        -I"$ROOT/include" "$ROOT/tests/reference/${probe}_probe.c" \
        "$BUILD_DIR/compat/libpiano.a" -o "$OUT/$probe-melodica"
    "$OUT/$probe-reference" > "$OUT/$probe-reference.txt"
    "$OUT/$probe-melodica" > "$OUT/$probe-melodica.txt"
    if ! diff -u "$OUT/$probe-reference.txt" "$OUT/$probe-melodica.txt" > "$OUT/$probe.diff"; then
        cat "$OUT/$probe.diff"
        exit 1
    fi
    printf '%s differential: identical\n' "$probe"
done

# Identical fixtures, count validation, ownership destruction and timed work.
# Run both orders; do not select a favorable sample or mix hosts.
for order in 1 2; do
    lanes='reference melodica'
    [ "$order" -eq 1 ] || lanes='melodica reference'
    for lane in $lanes; do
        "$OUT/playlist-$lane" --bench > "$OUT/playlist-$lane-bench-$order.txt"
        printf '\n%s pass %s\n' "$lane" "$order"
        cat "$OUT/playlist-$lane-bench-$order.txt"
    done
done
{
    wc -c "$OUT/libpiano-reference.a" "$BUILD_DIR/compat/libpiano.a"
    size "$OUT/playlist-reference" "$OUT/playlist-melodica" \
        "$OUT/search-reference" "$OUT/search-melodica" \
        "$OUT/station_mutations-reference" "$OUT/station_mutations-melodica" \
        "$OUT/feedback-reference" "$OUT/feedback-melodica" \
        "$OUT/seed-reference" "$OUT/seed-melodica" \
        "$OUT/station_info-reference" "$OUT/station_info-melodica" \
        "$OUT/quickmix_genre-reference" "$OUT/quickmix_genre-melodica"
    printf '\nDynamic dependencies are not included in archive bytes:\n'
    for binary in playlist search station_mutations feedback seed station_info quickmix_genre; do
        ldd "$OUT/$binary-reference"
        ldd "$OUT/$binary-melodica"
    done
} > "$OUT/artifact-sizes.txt"
cat "$OUT/artifact-sizes.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        printf '## libpiano compatibility\n\nReference `%s`; login/station, playlist, search, station-mutation, feedback/rating, seed-mutation, station-info, QuickMix/genre and transform-station differential probes passed.\n\n' "$REV"
        printf 'Playlist API timings are a separate league, not a five-language score.\n\n```text\n'
        cat "$OUT"/playlist-*-bench-*.txt
        cat "$OUT/artifact-sizes.txt"
        printf '\n```\n'
    } >> "$GITHUB_STEP_SUMMARY"
fi
