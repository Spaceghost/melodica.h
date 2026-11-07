#!/bin/sh
# Refresh the apps/ subtrees from their repositories (squashed). Usage: apps/pull.sh [dir...]
set -eu
cd "$(dirname "$0")/.."
list='
melodica-web https://github.com/Spaceghost/melodica-web master
pithos https://github.com/Spaceghost/pithos master
elpis https://github.com/Spaceghost/elpis-melodica master
epimetheus https://github.com/Spaceghost/epimetheus dev
pandoroid https://github.com/Spaceghost/pandoroid master
xivpiano https://github.com/Spaceghost/xivpiano-melodica integration/melodica
umbra-piano https://github.com/Spaceghost/umbra-piano main
pianobar https://github.com/Spaceghost/pianobar master
pianobar-windows https://github.com/Spaceghost/pianobar-windows develop
pydora https://github.com/Spaceghost/pydora master
'
want="$*"
echo "$list" | while read -r dir url branch; do
  [ -n "$dir" ] || continue
  if [ -n "$want" ]; then case " $want " in *" $dir "*) ;; *) continue;; esac; fi
  echo "== apps/$dir <- $url ($branch)"
  git subtree pull --prefix="apps/$dir" "$url" "$branch" --squash -m "apps/$dir: update from $url ($branch)"
done
