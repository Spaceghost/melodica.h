#!/usr/bin/env bash
# Package dist/ into release assets:
#   melodica-extension-<ver>-chrome.zip    unpacked-extension zip (chrome://extensions, Load unpacked after unzipping)
#   melodica-extension-<ver>-firefox.zip   unpacked-extension zip (about:debugging "Load Temporary Add-on" or `web-ext run`)
#   melodica-extension-<ver>-src.tar.gz    source tree
#   SHA256SUMS
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
v="${1:-$(cat dist/VERSION)}"
out="${OUT:-$here/release}"
rm -rf "$out"; mkdir -p "$out"
for b in chrome firefox; do
  ( cd "dist/$b" && zip -q -X -r "$out/melodica-extension-$v-$b.zip" . )
done
tar --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./build --exclude=./release \
    --exclude='./tests/artifacts' --exclude='./*.zip' --exclude='./*.tar.gz' \
    --transform "s,^\./,melodica-extension-$v/," -czf "$out/melodica-extension-$v-src.tar.gz" .
( cd "$out" && sha256sum melodica-extension-*.zip melodica-extension-*-src.tar.gz > SHA256SUMS && cat SHA256SUMS )
ls -l "$out"
