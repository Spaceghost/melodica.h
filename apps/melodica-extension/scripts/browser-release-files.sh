#!/usr/bin/env bash
# All jobs of a browser cut use the same admitted worker. Keep the packages and
# proofs between checkouts, including a partial retry of a single browser job.
set -euo pipefail
operation=$1
group=$2
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ && "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
umask 077
root="$RUNNER_TOOL_CACHE/melodica-releases/$GITHUB_RUN_ID-$GITHUB_SHA"
case "$group" in
  packages) files=(dist release build/node build/core/melodica_core.wasm) ;;
  smoke-extension|smoke-brave|smoke-firefox) files=(tests/artifacts/"$group".json tests/artifacts/"$group"-*.png)
    if [[ "$group" == smoke-firefox ]]; then files+=(tests/artifacts/smoke-firefox-node-probe.json); fi ;;
  *) exit 2 ;;
esac
if [[ "$operation" == save ]]; then
  mkdir -p "$root/$GITHUB_RUN_ATTEMPT"
  temp=$(mktemp -d "$root/$GITHUB_RUN_ATTEMPT/$group.XXXXXX")
  tar -czf "$temp/files.tar.gz" -- "${files[@]}"
  (cd "$temp" && sha256sum files.tar.gz > SHA256SUMS)
  mv -T "$temp" "$root/$GITHUB_RUN_ATTEMPT/$group"
elif [[ "$operation" == restore ]]; then
  for ((n=GITHUB_RUN_ATTEMPT;n>=1;n--)); do
    source_dir="$root/$n/$group"
    if [[ -f "$source_dir/SHA256SUMS" ]]; then
      (cd "$source_dir" && sha256sum -c SHA256SUMS)
      tar -xzf "$source_dir/files.tar.gz"
      exit 0
    fi
  done
  echo "Missing verified $group for this release run" >&2
  exit 1
else
  exit 2
fi
