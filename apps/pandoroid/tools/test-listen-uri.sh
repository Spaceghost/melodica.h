#!/bin/sh
# src/org/melodica/listen: the reference test cases, then a differential run against the
# reference parser on 30000 generated links when LISTEN_URI_REFERENCE names a copy of
# melodica-scrobble's src/listen-uri.js (not vendored: that repository is private).
# Needs javac and node.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
javac --release 8 -nowarn -d "$work/classes" src/org/melodica/listen/*.java test/org/melodica/listen/*.java 2>&1 | grep -v '^Note:' || true
java -cp "$work/classes" org.melodica.listen.ListenUriTest
if [ -z "${LISTEN_URI_REFERENCE:-}" ]; then echo "differential: skipped (LISTEN_URI_REFERENCE not set)"; exit 0; fi
node tools/listen-diff-gen.mjs 30000 > "$work/in.txt"
node tools/listen-diff-canon.mjs "$LISTEN_URI_REFERENCE" < "$work/in.txt" > "$work/want.txt"
java -cp "$work/classes" org.melodica.listen.ListenUriTest --canon < "$work/in.txt" > "$work/got.txt"
if diff "$work/want.txt" "$work/got.txt" > "$work/diff.txt"; then
  echo "differential: $(wc -l < "$work/in.txt") links, $(grep -vc '^null$' "$work/want.txt") accepted, identical to the reference"
else
  echo "differential: the port differs from the reference:"; head -40 "$work/diff.txt"; exit 1
fi
