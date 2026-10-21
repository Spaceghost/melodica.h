#!/bin/sh
# Build the entire pinned application with melodica's released C libpiano API.
# Reference source is archived into a fresh directory and remains untouched.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CC=${CC:-gcc}
WORK_DIR=${WORK_DIR:-"$ROOT/build/pianobar-integration"}
EVIDENCE_DIR=${EVIDENCE_DIR:-"$ROOT/docs/evidence/pianobar-integration-$(date -u +%Y-%m-%dT%H%M%SZ)"}
REV=$(cat "$ROOT/tests/reference/pianobar.rev")
case "$REV" in *[!0-9a-f]*|'') echo 'Invalid reference revision' >&2; exit 1;; esac
[ "${#REV}" -eq 40 ] || exit 1
REFERENCE=${PIANOBAR_REFERENCE:-"$ROOT/.cache/pianobar-$REV"}
mkdir -p "$WORK_DIR" "$EVIDENCE_DIR"
WORK_DIR=$(CDPATH= cd -- "$WORK_DIR" && pwd)
EVIDENCE_DIR=$(CDPATH= cd -- "$EVIDENCE_DIR" && pwd)
python3 - "$EVIDENCE_DIR" <<'PY'
from pathlib import Path
import sys
if any(Path(sys.argv[1]).iterdir()):
    raise SystemExit('Evidence directory must be empty; choose a new EVIDENCE_DIR')
PY
case "$REFERENCE" in /*) ;; *) REFERENCE="$PWD/$REFERENCE";; esac
RUN=$(mktemp -d "$WORK_DIR/run.XXXXXXXX")
APP="$RUN/pianobar"
BUILD="$RUN/melodica-build"
mkdir "$APP"
printf 'incomplete\n' > "$EVIDENCE_DIR/status.txt"
finish() {
    status=$?
    if [ "$status" -ne 0 ]; then
        printf 'failed (exit %s)\n' "$status" > "$EVIDENCE_DIR/status.txt"
        printf 'Integration failed; retained workspace: %s\n' "$RUN" >&2
    fi
}
trap finish EXIT
if [ ! -d "$REFERENCE/.git" ]; then
    [ ! -e "$REFERENCE" ] || { echo 'Reference exists without .git' >&2; exit 1; }
    git init "$REFERENCE"
    git -C "$REFERENCE" remote add origin https://github.com/PromyLOPh/pianobar.git
    git -C "$REFERENCE" fetch --depth=1 origin "$REV"
    git -C "$REFERENCE" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$REFERENCE" rev-parse HEAD)" = "$REV" ]
[ -z "$(git -C "$REFERENCE" status --porcelain --untracked-files=no)" ]
git -C "$REFERENCE" archive "$REV" > "$RUN/pianobar-source.tar"
tar -xf "$RUN/pianobar-source.tar" -C "$APP"
python3 - "$APP" "$EVIDENCE_DIR/application-source-sha256.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in sorted(root.rglob('*')) if p.is_file()}
Path(sys.argv[2]).write_text(json.dumps(files, indent=2) + '\n')
PY
python3 - "$ROOT" "$EVIDENCE_DIR/protocol-source-sha256.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
files = sorted((root / 'compat').rglob('*')) + [root / 'include/piano.h', root / 'Makefile']
hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in files if p.is_file()}
Path(sys.argv[2]).write_text(json.dumps(hashes, indent=2) + '\n')
PY
{
    printf 'pianobar_reference=%s\nworkspace=%s\n' "$REV" "$RUN"
    printf 'melodica_revision=%s\n' "${MELODICA_SOURCE_REVISION:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf unavailable)}"
    "$CC" --version
    uname -a
    [ ! -r /etc/os-release ] || cat /etc/os-release
    pkg-config --modversion libavcodec libavformat libavutil libavfilter libcurl ao libgcrypt json-c
} > "$EVIDENCE_DIR/environment.txt"
make -C "$ROOT" CC="$CC" BUILD="$BUILD" libpiano > "$EVIDENCE_DIR/protocol-build.log" 2>&1
ARCHIVE="$BUILD/compat/libpiano.a"
CFLAGS='-O2 -std=c99 -Wall -Wextra -D_DEFAULT_SOURCE -DMELODICA_PIANO_LEGACY_GCRYPT'
make -B -C "$APP" pianobar CC="$CC" DYNLINK=0 \
    LIBPIANO_INCLUDE="$ROOT/include" LIBPIANO_OBJ="$ARCHIVE" \
    CFLAGS="$CFLAGS" \
    LDFLAGS="-Wl,-Map,$EVIDENCE_DIR/link.map,--trace-symbol=PianoInit,--trace-symbol=PianoRequest,--trace-symbol=PianoResponse" \
    > "$EVIDENCE_DIR/application-build.log" 2>&1
nm -A -g --defined-only "$ARCHIVE" > "$EVIDENCE_DIR/protocol-symbols.txt"
nm -g --defined-only "$APP/pianobar" > "$EVIDENCE_DIR/application-symbols.txt"
readelf -d "$APP/pianobar" > "$EVIDENCE_DIR/dynamic-dependencies.txt"
ldd "$APP/pianobar" >> "$EVIDENCE_DIR/dynamic-dependencies.txt"
python3 - "$ROOT" "$APP" "$ARCHIVE" "$EVIDENCE_DIR" <<'PY'
from pathlib import Path
import hashlib, json, sys
root, app, archive, evidence = map(Path, sys.argv[1:])
original = json.loads((evidence / 'application-source-sha256.json').read_text())
assert all(hashlib.sha256((app / p).read_bytes()).hexdigest() == digest
           for p, digest in original.items()), 'application sources changed'
objects = ['main', 'debug', 'player', 'settings', 'terminal',
           'ui_act', 'ui', 'ui_readline', 'ui_dispatch']
assert all((app / 'src' / (name + '.o')).is_file() for name in objects)
header = str(root / 'include/piano.h')
for name in ['main', 'player', 'settings', 'ui_act', 'ui', 'ui_readline', 'ui_dispatch']:
    dependencies = (app / 'src' / (name + '.d')).read_text()
    assert header in dependencies, name + ': replacement header missing'
    assert 'src/libpiano/piano.h' not in dependencies, name + ': bundled header used'
link = (evidence / 'link.map').read_text()
assert str(archive) + '(piano.o)' in link, 'replacement archive not linked'
assert not any((app / 'src/libpiano').glob('*.o')), 'bundled protocol was compiled'
symbols = (evidence / 'application-symbols.txt').read_text()
for name in ['PianoInit', 'PianoRequest', 'PianoResponse', 'PianoDestroy']:
    assert any(line.split()[-1] == name for line in symbols.splitlines()), name + ' missing'
artifacts = [app / 'pianobar', archive, root / 'include/piano.h']
artifacts += [app / 'src' / (name + '.o') for name in objects]
(evidence / 'artifacts.sha256').write_text(''.join(
    hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + str(p) + '\n' for p in artifacts))
(evidence / 'provenance.json').write_text(json.dumps({
    'executable': str(app / 'pianobar'), 'protocol_archive': str(archive),
    'public_header': header, 'application_objects': objects,
    'application_sources_unchanged': True, 'bundled_protocol_objects': False,
    'header_dependency_checks': 7, 'player_compatibility_patch': None,
}, indent=2) + '\n')
PY
# Link the actual player.o to a harness selecting libao's null driver and
# recording PCM; HTTP and UI are not involved in this local-file player check.
# pkg-config output is intentionally split into compiler/linker arguments.
# shellcheck disable=SC2046
"$CC" $CFLAGS -I"$ROOT/include" -I"$APP/src" \
    $(pkg-config --cflags libavcodec libavformat libavutil libavfilter ao libgcrypt) \
    "$ROOT/tests/pianobar_player.c" "$APP/src/player.o" "$APP/src/debug.o" \
    -Wl,--wrap=ao_default_driver_id,--wrap=ao_open_live,--wrap=ao_play \
    $(pkg-config --libs libavcodec libavformat libavutil libavfilter ao libgcrypt) \
    -lpthread -lm -o "$RUN/player-check" > "$EVIDENCE_DIR/player-build.log" 2>&1
python3 - "$APP/pianobar" "$RUN" "$EVIDENCE_DIR" <<'PY'
from pathlib import Path
import hashlib, json, math, os, struct, subprocess, sys, wave
binary, run, evidence = map(Path, sys.argv[1:])
isolator = None
for candidate in [['unshare', '-n'], ['unshare', '-Urn']]:
    if subprocess.run(candidate + ['true'], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode == 0:
        isolator = candidate
        break
assert isolator is not None, 'network namespace required for offline checks'
config = run / 'empty-config'
config.mkdir()
environment = dict(os.environ, XDG_CONFIG_HOME=str(config), PIANOBAR_DEBUG='0')
startup = subprocess.run(isolator + [str(binary)], input=b'\n',
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment, timeout=15)
(evidence / 'startup.log').write_bytes(startup.stdout)
assert startup.returncode == 0, 'config-free startup failed'
assert b'Welcome to pianobar' in startup.stdout and b'Email:' in startup.stdout
assert b'Login...' not in startup.stdout, 'unexpected login attempt'
assert not list(config.rglob('*')), 'config-free startup created config data'
samples = [round(10000 * math.sin(2 * math.pi * 440 * i / 44100)) for i in range(44100)]
pcm = struct.pack('<44100h', *samples)
wav = run / 'synthetic-440hz.wav'
with wave.open(str(wav), 'wb') as output:
    output.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
    output.writeframes(pcm)
decoded = run / 'decoded.pcm'
player = subprocess.run(isolator + [str(run / 'player-check'), str(wav), str(decoded)],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment, timeout=30)
(evidence / 'player.log').write_bytes(player.stdout)
assert player.returncode == 0, 'synthetic player check failed'
actual = decoded.read_bytes()
assert actual == pcm, 'decoded PCM differs from generated one-second tone'
checks = {'startup': 'passed', 'startup_exit': startup.returncode,
    'configuration': 'empty XDG_CONFIG_HOME; blank email; no credentials',
    'network_namespace': isolator, 'synthetic_player': 'passed',
    'player_object': 'same src/player.o linked into the full application',
    'audio_output': 'libao null driver; linker wrappers reject other devices',
    'sample_rate': 44100, 'channels': 1, 'sample_bits': 16, 'samples': 44100,
    'decoded_bytes': len(actual), 'decoded_sha256': hashlib.sha256(actual).hexdigest(),
    'decoded_matches_input': True, 'live_pandora_tested': False}
(evidence / 'checks.json').write_text(json.dumps(checks, indent=2) + '\n')
PY
[ -z "$(git -C "$REFERENCE" status --porcelain --untracked-files=no)" ]
sha256sum "$ROOT/scripts/pianobar-integration.sh" "$ROOT/tests/pianobar_player.c" \
    > "$EVIDENCE_DIR/integration-inputs.sha256"
printf 'passed\n' > "$EVIDENCE_DIR/status.txt"
printf 'Full pianobar integration passed. Executable: %s\nEvidence: %s\n' "$APP/pianobar" "$EVIDENCE_DIR"
