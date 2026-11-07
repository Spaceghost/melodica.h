#!/usr/bin/env bash
# Upload a package to the Microsoft Edge Add-ons product's draft submission and publish it,
# through the Edge Add-ons REST API v1.1 (API key auth):
#   https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
#
#   EDGE_PRODUCT_ID=<guid> EDGE_CLIENT_ID=<guid> EDGE_API_KEY=<key> scripts/edge-publish.sh <zip> [notes]
#
# The product itself (listing, hidden visibility, privacy answers) is created once in Partner
# Center; the API only updates its package. Exits non-zero on any API error, with the
# response body (which never contains the credentials) in the log.
set -euo pipefail
zip="${1:?usage: edge-publish.sh <zip> [notes]}"
notes="${2:-Automated update from GitHub Actions ($(basename "$zip"))}"
: "${EDGE_PRODUCT_ID:?}" "${EDGE_CLIENT_ID:?}" "${EDGE_API_KEY:?}"
[[ -s "$zip" ]] || { echo "::error::$zip is empty or missing"; exit 1; }
api="https://api.addons.microsoftedge.microsoft.com/v1/products/$EDGE_PRODUCT_ID"
hdr=(-H "Authorization: ApiKey $EDGE_API_KEY" -H "X-ClientID: $EDGE_CLIENT_ID")
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# POST -> 202 with the operation id in the Location header.
start() { # $1 = path, rest = curl args; prints the operation id
  local code
  code="$(curl -sS -o "$tmp/body" -D "$tmp/head" -w '%{http_code}' "${hdr[@]}" -X POST "${@:2}" "$api$1")"
  if [[ "$code" != 202 ]]; then echo "::error::POST $1 returned HTTP $code: $(cat "$tmp/body")"; exit 1; fi
  local loc; loc="$(tr -d '\r' < "$tmp/head" | awk 'tolower($1)=="location:"{print $2}' | tail -1)"
  [[ -n "$loc" ]] || { echo "::error::POST $1: 202 without a Location header"; exit 1; }
  echo "${loc##*/}"
}
# GET the operation until it leaves InProgress; fails unless it Succeeded.
wait_for() { # $1 = operations path, $2 = label
  local i status
  for i in $(seq 1 90); do
    local code; code="$(curl -sS -o "$tmp/op" -w '%{http_code}' "${hdr[@]}" "$api$1")"
    [[ "$code" == 200 || "$code" == 202 ]] || { echo "::error::GET $1 returned HTTP $code: $(cat "$tmp/op")"; exit 1; }
    status="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' < "$tmp/op" 2>/dev/null || true)"
    echo "$2: $status"
    case "$status" in
      Succeeded) return 0 ;;
      InProgress|"") sleep 10 ;;
      *) echo "::error::$2 $status: $(cat "$tmp/op")"; exit 1 ;;
    esac
  done
  echo "::error::$2 still InProgress after 15 minutes: $(cat "$tmp/op")"; exit 1
}

echo "Edge Add-ons: uploading $(basename "$zip") ($(stat -c %s "$zip") bytes) to product $EDGE_PRODUCT_ID"
op="$(start /submissions/draft/package -H 'Content-Type: application/zip' --data-binary "@$zip")"
wait_for "/submissions/draft/package/operations/$op" "package upload"
echo "Edge Add-ons: publishing the draft submission"
op="$(start /submissions -H 'Content-Type: application/json' --data "$(python3 -c 'import json,sys; print(json.dumps({"notes": sys.argv[1]}))' "$notes")")"
wait_for "/submissions/operations/$op" "publish"
echo "Edge Add-ons: submission accepted; certification continues in Partner Center (https://partner.microsoft.com/dashboard/microsoftedge/$EDGE_PRODUCT_ID/packages/dashboard)"
