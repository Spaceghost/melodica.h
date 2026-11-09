#!/bin/sh
# Static checks on dist/: the ES modules parse, index.html references only
# relative paths and contains no inline scripts (CSP: script-src 'self').
set -eu
cd "$(dirname "$0")/.."
test -d dist || { echo "run scripts/build.sh first" >&2; exit 1; }
for f in dist/app.js dist/piano.js dist/bridge.js dist/account.js dist/vault.js dist/scrobble.js dist/lastplay.js dist/melodica.js dist/vendor/scrobble-ui/scrobble-ui.js; do
    node --check "$f" && echo "parse ok: $f"
done
# Loaded resources (script src, stylesheet href) must be relative; <a href>
# links to other sites are fine.
if grep -nE '(<script[^>]* src|<link[^>]* href|<img[^>]* src)="(https?:)?//' dist/index.html; then
    echo "index.html loads an absolute URL" >&2; exit 1
fi
if grep -nE '(src|href)="/' dist/index.html; then
    echo "index.html references root-relative URLs (must work under a sub-path)" >&2; exit 1
fi
if grep -nE '<script[^>]*>[^<]*[^<[:space:]]' dist/index.html; then
    echo "index.html contains an inline script" >&2; exit 1
fi
if grep -nE ' on[a-z]+="' dist/index.html; then
    echo "index.html contains inline event handlers" >&2; exit 1
fi
for f in index.html app.js piano.js bridge.js account.js vault.js scrobble.js lastplay.js app.css melodica.js melodica.wasm vendor/scrobble-ui/scrobble-ui.js vendor/scrobble-ui/scrobble-ui.css LICENSE LICENSE.libpiano THIRD_PARTY_NOTICES.md; do
    test -s "dist/$f" || { echo "missing dist/$f" >&2; exit 1; }
done
size=$(wc -c < dist/melodica.wasm)
test "$size" -gt 20000 || { echo "melodica.wasm is implausibly small ($size bytes)" >&2; exit 1; }
echo "static checks ok (melodica.wasm $size bytes)"
