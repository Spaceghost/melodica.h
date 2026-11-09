#!/bin/sh
# Plain-JVM tests of src/org/melodica/scrobble against tools/fake_lb.py (needs javac, python3).
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'kill $fake 2>/dev/null || true; rm -rf "$work"' EXIT
javac --release 8 -nowarn -d "$work/classes" src/org/melodica/scrobble/*.java test/org/melodica/scrobble/*.java 2>&1 | grep -v "bootstrap\|^warning\|^1 warning\|^Note:" || true
port=$((20000 + $$ % 20000))
token=sgs_fake_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
python3 tools/fake_lb.py "$port" "$work/log.jsonl" --token "$token" --fail 2 --prefix /scrobble &
fake=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do python3 -c "import socket;socket.create_connection(('127.0.0.1',$port),1)" 2>/dev/null && break; sleep 0.3; done
java -cp "$work/classes" org.melodica.scrobble.ScrobblerTest "http://127.0.0.1:$port/scrobble/" "$token" "$work/log.jsonl" | tee "$work/out.txt"
grep -q "^PASS" "$work/out.txt"
! grep -q "$token" "$work/out.txt"
echo "token absent from test output"
