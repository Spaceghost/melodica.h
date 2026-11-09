#!/bin/sh
# Fetch the shared Scrobbles UI (spaceghost-scrobble ui/dist, contract v1 in its
# docs/CLIENTS.md) into web/vendor/scrobble-ui/, pinned by scrobble-ui.pin:
#   commit=<full sha>  js_sha256=<hex>  css_sha256=<hex>
# The files are not in this repository (spaceghost-scrobble is private; the same files
# are served publicly at https://spacegho.st/scrobble/assets/ui/<commit>/). With gh signed in to
# a GitHub account that can read the repository, the pinned commit is fetched; otherwise
# (CI) the public copy is fetched. Either way each file must match its sha256.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
. ./scrobble-ui.pin
OUT=web/vendor/scrobble-ui
mkdir -p "$OUT"
GH=${GH:-$(command -v gh || echo /home/linuxbrew/.linuxbrew/bin/gh)}
fetch() { # name expected-sha256
  tmp="$OUT/.$1.part"
  if [ -x "$GH" ] && "$GH" api -H 'Accept: application/vnd.github.raw' "repos/Spaceghost/spaceghost-scrobble/contents/ui/dist/$1?ref=$commit" > "$tmp" 2>/dev/null; then
    src="Spaceghost/spaceghost-scrobble@$commit"
  else
    # The immutable copy of the pinned build (every commit's ui/dist is kept there).
    url="${SCROBBLE_UI_BASE:-https://spacegho.st/scrobble/assets/ui}/$commit/$1"
    curl -fsSL --retry 3 "$url" -o "$tmp"
    src="$url"
  fi
  got=$(sha256sum "$tmp" | cut -d' ' -f1)
  if [ "$got" != "$2" ]; then
    rm -f "$tmp"
    echo "fetch-scrobble-ui: $1 from $src has sha256 $got, the pin says $2" >&2
    exit 1
  fi
  mv "$tmp" "$OUT/$1"
  echo "fetch-scrobble-ui: $1 ok ($src)"
}
fetch scrobble-ui.js "$js_sha256"
fetch scrobble-ui.css "$css_sha256"
