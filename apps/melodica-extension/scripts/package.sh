#!/usr/bin/env bash
# Package dist/ into release assets:
#   melodica-extension-<ver>-chrome.zip    unpacked-extension zip (chrome://extensions, Load unpacked after unzipping)
#   melodica-extension-<ver>-firefox.zip   unpacked-extension zip (about:debugging "Load Temporary Add-on" or `web-ext run`)
#   melodica-extension-<ver>.xpi           the Firefox build as an installable add-on (same bytes as the firefox zip;
#                                          unsigned here; CI replaces it with the AMO-signed file when it has AMO credentials)
#   melodica-extension-<ver>.crx           CRX3 of the Chrome build, signed with the key at $CRX_KEY (skipped when unset)
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
cp "$out/melodica-extension-$v-firefox.zip" "$out/melodica-extension-$v.xpi"
if [ -n "${CRX_KEY:-}" ]; then
  [ -s "$CRX_KEY" ] || { echo "CRX_KEY=$CRX_KEY is empty or missing" >&2; exit 1; }
  # crx3 would mint a fresh key if the file were unreadable; the check above and the id
  # printed here (compared by CI against the expected id) keep that from passing silently.
  npx --no-install crx3 -p "$CRX_KEY" -o "$out/melodica-extension-$v.crx" < "$out/melodica-extension-$v-chrome.zip" >/dev/null
  echo "crx id: $(node scripts/crx-id.mjs "$CRX_KEY")"
else
  echo "CRX_KEY unset: no .crx built" >&2
fi
tar --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./build --exclude=./release \
    --exclude='./tests/artifacts' --exclude='./*.zip' --exclude='./*.tar.gz' --exclude='./*.pem' \
    --transform "s,^\./,melodica-extension-$v/," -czf "$out/melodica-extension-$v-src.tar.gz" .
( cd "$out" && sha256sum $(ls melodica-extension-*.zip melodica-extension-*.xpi melodica-extension-*.crx melodica-extension-*-src.tar.gz 2>/dev/null) > SHA256SUMS && cat SHA256SUMS )
ls -l "$out"
