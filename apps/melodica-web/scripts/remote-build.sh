#!/bin/sh
# Sync this checkout into an emsdk container on bak, build there, run the
# checks and smoke test, and pull dist/ back. Never compiles on the host.
# Usage: scripts/remote-build.sh   (env: MW_HOST=bak MW_CONTAINER=melodica-emsdk)
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOST=${MW_HOST:-bak}
CONTAINER=${MW_CONTAINER:-melodica-emsdk}
DEST=${MW_DEST:-/work/melodica-web}
cd "$ROOT"
tar cf - --exclude=dist --exclude=.git --exclude='vendor/melodica.h/.git' --exclude='vendor/melodica.h/build' . \
  | ssh "$HOST" "incus --project ${MW_PROJECT:-default} exec $CONTAINER -- bash -c 'mkdir -p $DEST && cd $DEST && tar xf - && \
      export PATH=/opt/emsdk/upstream/emscripten:\$(echo /opt/emsdk/node/*/bin):\$PATH && \
      MELODICA_WEB_VERSION=${MELODICA_WEB_VERSION:-} scripts/build.sh && scripts/check.sh && \
      PANDORA_USER=\"${PANDORA_USER:-}\" PANDORA_PASSWORD=\"${PANDORA_PASSWORD:-}\" node tests/node-smoke.mjs && node tests/node-unit.mjs && node tests/bridge-unit.mjs && node tests/gate-unit.mjs && node tests/inserts-unit.mjs'"
rm -rf dist
ssh "$HOST" "incus --project ${MW_PROJECT:-default} exec $CONTAINER -- bash -c 'cd $DEST && tar cf - dist'" | tar xf -
ls -l dist
