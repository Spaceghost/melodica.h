#!/bin/sh
# End-to-end check of the built-in scrobbler against ci/fake-listenbrainz.py:
# now playing and a listen that both fail (503), the listen lands in the queue,
# then the queue flush sends it as an import. Needs `make test/listenbrainz_e2e` first.
set -eu
port=${1:-18080}
work=$(mktemp -d)
token="fake-token-$$"
python3 -I ci/fake-listenbrainz.py "$port" "$work/log.jsonl" --token "$token" --fail 2 --prefix /scrobble &
fake=$!
trap 'kill $fake 2>/dev/null || true; rm -rf "$work"' EXIT
i=0; until python3 -c "import socket; socket.create_connection(('127.0.0.1', $port), 1)" 2>/dev/null; do
  i=$((i+1)); [ $i -lt 50 ] || { echo "fake server did not start" >&2; exit 1; }; sleep 0.1; done
printf '%s\n' "$token" | ./test/listenbrainz_e2e "http://127.0.0.1:$port/scrobble" "$work/queue" \
  "melodica-client-test pianobar" > "$work/out.txt"
cat "$work/out.txt"
python3 -I - "$work/log.jsonl" "$work/out.txt" "$token" <<'PY'
import json, sys
log = [json.loads(l) for l in open(sys.argv[1])]
out = open(sys.argv[2]).read()
token = sys.argv[3]
seen = [(r['listen_type'], r['status']) for r in log]
print('fake server saw:', seen)
assert seen == [('playing_now', 503), ('single', 503), ('import', 200)], seen
info = log[2]['payload'][0]['track_metadata']['additional_info']
assert log[2]['payload'][0]['track_metadata']['track_name'] == 'melodica-client-test pianobar'
assert info['art_url'].startswith('http://'), info
assert info['station_name'] == 'Test Station' and info['duration_ms'] == 200000, info
assert info['music_service'] == 'pandora.com' and info['submission_client'] == 'pianobar', info
assert not any(k.startswith('pandora_') for k in info), info
assert 'listened_at' not in log[0]['payload'][0]
assert token not in open(sys.argv[1]).read() and token not in out, 'token leaked'
print('listenbrainz e2e: ok')
PY
