#!/usr/bin/env bash
# Rewrite scrobble-ui.pin from the live https://spacegho.st/scrobble/assets/ui/latest.json
# (commit, content hash, sha256 of each file), then fetch and check the files.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
curl -fsS https://spacegho.st/scrobble/assets/ui/latest.json | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const l = JSON.parse(s);
  if (!/^[0-9a-f]{40}$/.test(l.commit) || !/^[0-9a-f]{16}$/.test(l.hash)) throw new Error("latest.json: bad commit or hash");
  const sums = ["scrobble-ui.js", "scrobble-ui.css"].map((n) => { if (!/^[0-9a-f]{64}$/.test(l.sha256[n])) throw new Error(`latest.json: no sha256 for ${n}`); return `${l.sha256[n]}  ${n}`; });
  process.stdout.write([`commit ${l.commit}`, `hash ${l.hash}`, ...sums].join("\n") + "\n");
});' > "$here/scrobble-ui.pin.new"
mv "$here/scrobble-ui.pin.new" "$here/scrobble-ui.pin"
"$here/scripts/fetch-scrobble-ui.sh"
echo "scrobble-ui.pin: $(awk '$1=="hash"{print $2}' "$here/scrobble-ui.pin")"
