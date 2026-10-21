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
PROBES='piano playlist search station_mutations feedback seed station_info quickmix_genre explain_bookmarks settings station_modes'
DIFF_PROBES="$PROBES coercion abi login"
# A failed rebuild must never leave an earlier success report looking current.
rm -f "$OUT/performance.txt" "$OUT/performance.json" "$OUT/status.txt"
printf 'incomplete\n' > "$OUT/status.txt"
finish() {
    status=$?
    if [ "$status" -ne 0 ]; then
        printf 'failed (exit %s)\n' "$status" > "$OUT/status.txt"
        [ ! -f "$OUT/build.log" ] || tail -n 100 "$OUT/build.log" >&2
    fi
}
trap finish EXIT
: > "$OUT/build.log"
run_build() {
    printf '\n$' >> "$OUT/build.log"
    printf ' %s' "$@" >> "$OUT/build.log"
    printf '\n' >> "$OUT/build.log"
    "$@" >> "$OUT/build.log" 2>&1
}
write_manifest() {
    python3 - "$BUILD_DIR" "$REV" "$CC" "$1" "$DIFF_PROBES" "$PROBES" <<'PY'
import hashlib, json, pathlib, subprocess, sys
build = pathlib.Path(sys.argv[1]).resolve()
revision, compiler, phase, probes, suites = sys.argv[2:]
output = build / 'libpiano-evidence'
paths = [output / 'libpiano-reference.a', build / 'compat/libpiano.a']
for probe in probes.split():
    paths += [output / (probe + suffix) for suffix in
              ('-reference', '-melodica', '-reference.txt', '-melodica.txt', '.diff')]
if phase == 'complete':
    paths += [output / ('api-' + lane) for lane in ('reference', 'melodica')]
    paths += [output / f'api-{suite}-{lane}.o' for suite in suites.split()
              for lane in ('reference', 'melodica')]
manifest = {'schema': 1, 'reference': revision, 'compiler': compiler,
            'compiler_version': subprocess.check_output([compiler, '--version'], text=True).splitlines()[0],
            'phase': phase,
            'sources': json.loads((output / 'sources.json').read_text()),
            'artifacts': {str(path.relative_to(build)): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in paths}}
(output / 'baseline-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
PY
}
case "$REV" in *[!0-9a-f]*|'') echo 'Invalid reference revision' >&2; exit 1;; esac
[ "${#REV}" -eq 40 ] || exit 1

{
    printf 'reference=%s\n' "$REV"
    git -C "$ROOT" rev-parse HEAD
    "$CC" --version
    uname -a
    [ ! -r /etc/os-release ] || cat /etc/os-release
    command -v lscpu >/dev/null 2>&1 && lscpu || :
    pkg-config --modversion json-c libgcrypt libcurl
    printf 'optimization=-O2; assertions enabled; no LTO; no native-CPU tuning\n'
} > "$OUT/environment.txt"
python3 - "$ROOT" "$OUT" <<'PY'
import hashlib, json, pathlib, subprocess, sys
root, output = map(pathlib.Path, sys.argv[1:])
files = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).split(b'\0')
hashes = {name.decode(): hashlib.sha256((root / name.decode()).read_bytes()).hexdigest()
          for name in files if name and (root / name.decode()).is_file()}
# Include new, uncommitted fixture/report files during development too.
for folder in ('compat', 'include', 'tests/reference', 'scripts'):
    for path in sorted((root / folder).rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            hashes[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
(output / 'sources.json').write_text(json.dumps(hashes, indent=2, sort_keys=True) + '\n')
PY

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
run_build make -B -C "$REF" CC="$CC" CFLAGS='-O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE' \
    src/libpiano/crypt.o src/libpiano/piano.o src/libpiano/request.o \
    src/libpiano/response.o src/libpiano/list.o
ar rcs "$OUT/libpiano-reference.a" \
    "$REF/src/libpiano/crypt.o" "$REF/src/libpiano/piano.o" \
    "$REF/src/libpiano/request.o" "$REF/src/libpiano/response.o" "$REF/src/libpiano/list.o"
# Rebuild both sides rather than benchmarking stale objects from other flags.
run_build make -B -C "$ROOT" CC="$CC" BUILD="$BUILD_DIR" libpiano
for probe in $DIFF_PROBES; do
    run_build "$CC" -O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE -DMELODICA_REFERENCE_UPSTREAM \
        -I"$REF/src/libpiano" $(pkg-config --cflags libavfilter libavformat) \
        "$ROOT/tests/reference/${probe}_probe.c" \
        "$OUT/libpiano-reference.a" $(pkg-config --libs libcurl libgcrypt json-c) -lm -lpthread \
        -o "$OUT/$probe-reference"
    run_build "$CC" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror \
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
write_manifest correctness

if [ "${LIBPIANO_CORRECTNESS_ONLY:-0}" = 1 ]; then
    printf 'correctness passed; benchmarks not requested\n' > "$OUT/status.txt"
    exit 0
fi

# Reuse each differential suite verbatim as a timed family workload. Compile into
# separate translation units so their private helpers retain their original scope.
for lane in reference melodica; do
    for probe in $PROBES; do
        object="$OUT/api-$probe-$lane.o"
        if [ "$lane" = reference ]; then
            run_build "$CC" -O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE \
                -DMELODICA_REFERENCE_UPSTREAM -I"$REF/src/libpiano" \
                $(pkg-config --cflags libavfilter libavformat) \
                -Dmain=api_"$probe" -Dtime=api_time_"$probe" \
                -D_POSIX_C_SOURCE=200809L -include "$ROOT/tests/reference/api_quiet.h" \
                -c "$ROOT/tests/reference/${probe}_probe.c" -o "$object"
        else
            run_build "$CC" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror \
                -I"$ROOT/include" -Dmain=api_"$probe" -Dtime=api_time_"$probe" \
                -D_POSIX_C_SOURCE=200809L -include "$ROOT/tests/reference/api_quiet.h" \
                -c "$ROOT/tests/reference/${probe}_probe.c" -o "$object"
        fi
    done
    # Positional parameters preserve paths containing spaces during linking.
    set --
    for probe in $PROBES; do set -- "$@" "$OUT/api-$probe-$lane.o"; done
    if [ "$lane" = reference ]; then
        run_build "$CC" -O2 -std=c99 -Wall -Wextra "$ROOT/tests/reference/api_bench.c" \
            "$@" "$OUT/libpiano-reference.a" $(pkg-config --libs libcurl libgcrypt json-c) \
            -lm -lpthread -o "$OUT/api-reference"
    else
        run_build "$CC" -O2 -std=c99 -pedantic-errors -Wall -Wextra -Werror \
            "$ROOT/tests/reference/api_bench.c" "$@" "$BUILD_DIR/compat/libpiano.a" \
            -o "$OUT/api-melodica"
    fi
done

# Identical fixtures, count validation, ownership destruction and timed work.
# Run both orders; do not select a favorable sample or mix hosts.
for order in 1 2; do
    lanes='reference melodica'
    [ "$order" -eq 1 ] || lanes='melodica reference'
    for lane in $lanes; do
        "$OUT/api-$lane" > "$OUT/api-$lane-bench-$order.txt"
        "$OUT/playlist-$lane" --bench > "$OUT/playlist-$lane-bench-$order.txt"
        printf '\n%s pass %s\n' "$lane" "$order"
        cat "$OUT/playlist-$lane-bench-$order.txt"
    done
done
python3 "$ROOT/scripts/libpiano-report.py" "$OUT"
{
    wc -c "$OUT/libpiano-reference.a" "$BUILD_DIR/compat/libpiano.a"
    size "$OUT/api-reference" "$OUT/api-melodica" \
        "$OUT/playlist-reference" "$OUT/playlist-melodica" \
        "$OUT/search-reference" "$OUT/search-melodica" \
        "$OUT/station_mutations-reference" "$OUT/station_mutations-melodica" \
        "$OUT/feedback-reference" "$OUT/feedback-melodica" \
        "$OUT/seed-reference" "$OUT/seed-melodica" \
        "$OUT/station_info-reference" "$OUT/station_info-melodica" \
        "$OUT/quickmix_genre-reference" "$OUT/quickmix_genre-melodica" \
        "$OUT/explain_bookmarks-reference" "$OUT/explain_bookmarks-melodica" \
        "$OUT/settings-reference" "$OUT/settings-melodica" \
        "$OUT/station_modes-reference" "$OUT/station_modes-melodica" \
        "$OUT/coercion-reference" "$OUT/coercion-melodica" \
        "$OUT/abi-reference" "$OUT/abi-melodica" \
        "$OUT/login-reference" "$OUT/login-melodica"
    printf '\nDynamic dependencies are not included in archive bytes:\n'
    for binary in playlist search station_mutations feedback seed station_info quickmix_genre explain_bookmarks settings station_modes coercion abi login; do
        ldd "$OUT/$binary-reference"
        ldd "$OUT/$binary-melodica"
    done
} > "$OUT/artifact-sizes.txt"
sha256sum "$OUT"/*-reference "$OUT"/*-melodica "$OUT/libpiano-reference.a" \
    "$BUILD_DIR/compat/libpiano.a" > "$OUT/artifacts.sha256"
cat "$OUT/artifact-sizes.txt"
write_manifest complete
printf 'passed\n' > "$OUT/status.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        printf '## libpiano compatibility\n\nReference `%s`; login/station, playlist, search, station-mutation, feedback/rating, seed-mutation, station-info, QuickMix/genre, transform-station, explanation/bookmark, settings station-mode and parser/coercion differential probes passed.\n\n' "$REV"
        printf 'All API family suites and scaled playlists run in a separate C compatibility league.\n\n```text\n'
        cat "$OUT/performance.txt"
        cat "$OUT/artifact-sizes.txt"
        printf '\n```\n'
    } >> "$GITHUB_STEP_SUMMARY"
fi
