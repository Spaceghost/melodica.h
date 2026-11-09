#!/bin/sh
# lib/listen/listen_uri.dart: the reference test cases, then a differential run against the
# reference parser on 30000 generated links when LISTEN_URI_REFERENCE names a copy of
# melodica-scrobble's src/listen-uri.js (not vendored: that repository is private).
# Needs dart (flutter's), node, and `flutter pub get` done. Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
dart tool/listen_uri_test.dart
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if [ -z "${LISTEN_URI_REFERENCE:-}" ]; then echo "differential: skipped (LISTEN_URI_REFERENCE not set)"; exit 0; fi
node tool/listen-diff-gen.mjs 30000 > "$work/in.txt"
node tool/listen-diff-canon.mjs "$LISTEN_URI_REFERENCE" < "$work/in.txt" > "$work/want.txt"
dart tool/listen_uri_test.dart --canon < "$work/in.txt" > "$work/got.txt"
if diff "$work/want.txt" "$work/got.txt" > "$work/diff.txt"; then
  echo "differential: $(wc -l < "$work/in.txt") links, $(grep -vc '^null$' "$work/want.txt") accepted, identical to the reference"
else
  echo "differential: the port differs from the reference:"; head -40 "$work/diff.txt"; exit 1
fi
