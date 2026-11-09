#!/bin/sh
# Live end-to-end check (README "Proof"): the Chromium (and with BROWSER=brave, Brave)
# smoke's "live" test with /scrobble/ going to the real https://spacegho.st under a
# throwaway Scrobbles account, and melodica-tuner for Pandora with 70 s songs so a
# single is due. Usage: LIVE_SCROBBLE_TOKEN_FILE=/path/to/token tests/live-e2e.sh
set -eu
: "${LIVE_SCROBBLE_TOKEN_FILE:?token file of the throwaway account}"
: "${MELODICA_TUNER_DIR:=/work/melodica-tuner}"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir "$W/audio"
D="$MELODICA_TUNER_DIR/tuner/data"
for f in "$D"/audio/*; do
  b=$(basename "$f")
  case "$b" in
    *.mp3|*.aac) for i in 1 2 3 4 5 6 7; do cat "$f"; done > "$W/audio/$b" ;;
    *) cp "$f" "$W/audio/$b" ;;
  esac
done
python3 - "$D/fixture.json" "$W/fixture.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for s in d['songs']:
    s['length'] = s.get('length', 10) * 7
json.dump(d, open(sys.argv[2], 'w'))
PY
export TUNER_FIXTURE="$W/fixture.json" TUNER_AUDIO_DIR="$W/audio" MELODICA_TUNER_DIR LIVE_SCROBBLE_TOKEN_FILE
xvfb-run -a npx playwright test -g "live:" "$@"
