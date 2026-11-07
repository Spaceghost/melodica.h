#!/usr/bin/env bash
# Build the iOS app (with its Safari Web Extension) from ios/melodica/melodica.xcodeproj.
# dist/safari must exist (scripts/package.sh safari); the project copies it into the
# extension's Resources on every build.
#
#   ios/scripts/build.sh device      Release, generic iOS (arm64), CODE_SIGNING_ALLOWED=NO
#                                    -> release/melodica-$V-unsigned.ipa (Payload/melodica.app)
#   ios/scripts/build.sh simulator   Debug, iOS Simulator, ad hoc ("-") signature -> build/sim/melodica.app
#
# env V: the version (x.y.z or x.y.z-suffix); MARKETING_VERSION gets x.y.z.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$here"
what="${1:?device or simulator}"
V="${V:-$(cat dist/VERSION 2>/dev/null || echo 0.0.0)}"
mv="${V%%-*}"
proj="$(ls -d ios/melodica/*.xcodeproj | head -1)"
[[ -f dist/safari/manifest.json ]] || { echo "dist/safari missing" >&2; exit 1; }
scheme="$(xcodebuild -list -json -project "$proj" | python3 -c '
import json,sys
p=json.load(sys.stdin)["project"]; s=[x for x in p["schemes"] if "xtension" not in x]
print((s or p["schemes"])[0])')"
echo "project $proj scheme $scheme version $mv ($V)"
common=(-project "$proj" -scheme "$scheme" -derivedDataPath build/dd MARKETING_VERSION="$mv" CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}")
case "$what" in
  device)
    xcodebuild "${common[@]}" -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" ARCHS=arm64 build | tail -60
    app="$(ls -d build/dd/Build/Products/Release-iphoneos/*.app | head -1)"
    [[ -d "$app/PlugIns" ]] || { echo "no PlugIns in $app" >&2; exit 1; }
    ls "$app" "$app"/PlugIns/*/
    rm -rf build/ipa && mkdir -p build/ipa/Payload release
    cp -R "$app" build/ipa/Payload/melodica.app
    ( cd build/ipa && zip -q -X -r -y "$here/release/melodica-$V-unsigned.ipa" Payload )
    ls -l release/
    ;;
  simulator)
    xcodebuild "${common[@]}" -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build | tail -60
    rm -rf build/sim && mkdir -p build/sim
    cp -R "$(ls -d build/dd/Build/Products/Debug-iphonesimulator/*.app | head -1)" build/sim/melodica.app
    ;;
  *) echo "device or simulator" >&2; exit 2 ;;
esac
