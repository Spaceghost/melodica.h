#!/usr/bin/env bash
# Sync this tree into the bak Incus container (default melodica-ext) at
# /work/melodica-extension, excluding node_modules/, dist/, build/ and
# test artifacts; then run the given command there (default: nothing).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
C="${CONTAINER:-melodica-ext}"
cd "$here"
tar --exclude=./node_modules --exclude=./dist --exclude=./build --exclude=./tests/artifacts --exclude=./.git -cf - . \
  | ssh bak "incus exec $C -- sh -c 'mkdir -p /work/melodica-extension && cd /work/melodica-extension && tar xf -'"
if [ $# -gt 0 ]; then
  ssh bak "incus exec $C --env HOME=/root --env NELUA=/opt/nelua/nelua -- sh -lc 'cd /work/melodica-extension && $*'"
fi
