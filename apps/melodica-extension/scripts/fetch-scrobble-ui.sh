#!/usr/bin/env bash
# Fetch the shared Scrobbles UI (melodica-scrobble ui/dist/, its docs/CLIENTS.md) at
# the commit in scrobble-ui.pin into vendor/scrobble-ui/ (gitignored: the files are not
# part of this source tree, only of the built extension). Each file must match the
# sha256 in the pin. Source: the pinned commit through `gh api` when it can read the
# repository, otherwise the copy spacegho.st serves at /scrobble/assets/ui/.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
pin="$here/scrobble-ui.pin"
out="$here/vendor/scrobble-ui"
commit="$(awk '$1=="commit"{print $2}' "$pin")"
[ -n "$commit" ] || { echo "scrobble-ui.pin: no commit" >&2; exit 1; }
mkdir -p "$out"
ok=1
while read -r sum name; do
  [ "$sum" = commit ] && continue
  [ -n "${name:-}" ] || continue
  f="$out/$name"
  if [ -s "$f" ] && echo "$sum  $f" | sha256sum -c --status; then continue; fi
  got=""
  if command -v "${GH:-gh}" >/dev/null 2>&1 && "${GH:-gh}" api -H 'Accept: application/vnd.github.raw' "repos/Spaceghost/melodica-scrobble/contents/ui/dist/$name?ref=$commit" > "$f.tmp" 2>/dev/null && echo "$sum  $f.tmp" | sha256sum -c --status; then
    got="commit $commit"
  elif curl -fsS "https://spacegho.st/scrobble/assets/ui/$commit/$name" -o "$f.tmp" 2>/dev/null && echo "$sum  $f.tmp" | sha256sum -c --status; then
    got="spacegho.st/scrobble/assets/ui/$commit"
  elif curl -fsS "https://spacegho.st/scrobble/assets/ui/$name" -o "$f.tmp" && echo "$sum  $f.tmp" | sha256sum -c --status; then
    got="spacegho.st/scrobble/assets/ui"
  fi
  if [ -n "$got" ]; then mv "$f.tmp" "$f"; echo "scrobble-ui: $name from $got"; else rm -f "$f.tmp"; echo "scrobble-ui: $name: no copy matches sha256 $sum" >&2; ok=0; fi
done < "$pin"
printf '%s\n' "$commit" > "$out/PIN"
[ "$ok" = 1 ]
