#!/usr/bin/env bash
# Rewrite scrobble-ui.pin from the live https://spacegho.st/scrobble/assets/ui/latest.json
# (commit, content hash, sha256 of each file), then fetch and check the files.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
pin="$here/scrobble-ui.pin"
tmp="$pin.new"
backup="$pin.backup"
curl -fsS https://spacegho.st/scrobble/assets/ui/latest.json |
  node "$here/scripts/write-scrobble-ui-pin.mjs" "$tmp"
cp "$pin" "$backup"
restore_pin() { cp "$backup" "$pin"; rm -f "$backup" "$tmp"; }
trap restore_pin ERR
mv "$tmp" "$pin"
"$here/scripts/fetch-scrobble-ui.sh"
rm -f "$backup"
trap - ERR
echo "scrobble-ui.pin: $(awk '$1=="hash"{print $2}' "$here/scrobble-ui.pin")"
