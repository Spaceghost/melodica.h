#!/usr/bin/env bash
# INACTIVE HOOK, never run yet: ios.yml calls this only when the repository has the
# secrets IOS_CERT_P12, IOS_CERT_PASSWORD and IOS_PROVISION_PROFILE (none exist today).
# Re-signs the unsigned .ipa for ad hoc distribution (devices listed in the profile;
# nothing is uploaded to Apple).
#
#   IOS_CERT_P12                   base64 of an "Apple Distribution" certificate + key (.p12)
#   IOS_CERT_PASSWORD              its password
#   IOS_PROVISION_PROFILE          base64 of an ad hoc .mobileprovision whose App ID covers
#                                  both st.spacegho.melodica and st.spacegho.melodica.Extension
#                                  (a wildcard such as TEAMID.st.spacegho.*), or only the app's
#                                  when IOS_PROVISION_PROFILE_EXTENSION is also set
#   IOS_PROVISION_PROFILE_EXTENSION  optional: base64 of the extension's own ad hoc profile
#
#   ios/scripts/sign-adhoc.sh <in-unsigned.ipa> <out-adhoc.ipa>
set -euo pipefail
in="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
work="$(mktemp -d)"; trap 'security delete-keychain "$work/sign.keychain-db" 2>/dev/null || true; rm -rf "$work"' EXIT
echo "$IOS_CERT_P12" | base64 --decode > "$work/cert.p12"
echo "$IOS_PROVISION_PROFILE" | base64 --decode > "$work/app.mobileprovision"
if [[ -n "${IOS_PROVISION_PROFILE_EXTENSION:-}" ]]; then echo "$IOS_PROVISION_PROFILE_EXTENSION" | base64 --decode > "$work/ext.mobileprovision"
else cp "$work/app.mobileprovision" "$work/ext.mobileprovision"; fi
kc="$work/sign.keychain-db"; kp="$(uuidgen)"
security create-keychain -p "$kp" "$kc"
security set-keychain-settings -lut 3600 "$kc"
security unlock-keychain -p "$kp" "$kc"
security import "$work/cert.p12" -k "$kc" -P "$IOS_CERT_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$kp" "$kc" >/dev/null
security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
identity="$(security find-identity -v -p codesigning "$kc" | awk 'NR==1{print $2}')"
[[ -n "$identity" ]] || { echo "no signing identity in IOS_CERT_P12" >&2; exit 1; }
ents() { # profile out.plist bundle: the profile's entitlements, a wildcard App ID made concrete
  security cms -D -i "$1" > "$work/p.plist"
  /usr/libexec/PlistBuddy -x -c 'Print :Entitlements' "$work/p.plist" > "$2"
  local team bid
  team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$work/p.plist")"
  bid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$3/Info.plist")"
  /usr/libexec/PlistBuddy -c "Set :application-identifier $team.$bid" "$2"
  /usr/libexec/PlistBuddy -c "Set :get-task-allow false" "$2" 2>/dev/null || true
}
( cd "$work" && unzip -q "$in" )
app="$work/Payload/melodica.app"
for appex in "$app"/PlugIns/*.appex; do
  cp "$work/ext.mobileprovision" "$appex/embedded.mobileprovision"
  ents "$work/ext.mobileprovision" "$work/ext.plist" "$appex"
  codesign --force --sign "$identity" --keychain "$kc" --entitlements "$work/ext.plist" "$appex"
done
cp "$work/app.mobileprovision" "$app/embedded.mobileprovision"
ents "$work/app.mobileprovision" "$work/app.plist" "$app"
codesign --force --sign "$identity" --keychain "$kc" --entitlements "$work/app.plist" "$app"
codesign --verify --deep --strict "$app"
( cd "$work" && rm -f "$out" && zip -q -X -r -y "$out" Payload )
ls -l "$out"
