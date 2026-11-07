#!/bin/sh
# Build the release APK, source tarball and SHA256SUMS into dist/.
# Used by .github/workflows/{build,release}.yml; runnable locally with an
# Android SDK (ANDROID_HOME), ndk-build on PATH and gradle on PATH.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

version=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' AndroidManifest.xml | head -n1)
[ -n "$version" ] || { echo "versionName not found in AndroidManifest.xml" >&2; exit 1; }

rm -rf dist libs obj build.env
mkdir -p dist

# 1. native: the repo's own reproducible ndk-build entry point
./build-native.sh
abis=$(ls libs | sort | paste -sd_ -)

# 2. throwaway signing key (release builds only; see release notes)
keystore=$project_dir/ci.keystore
rm -f "$keystore"
keytool -genkeypair -v -keystore "$keystore" -storepass pandoroid -keypass pandoroid \
    -alias pandoroid-ci -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Pandoroid CI throwaway key, O=Spaceghost/pandoroid" >/dev/null 2>&1

# 3. apk
gradle --no-daemon --console=plain -q assembleRelease \
    -PciKeystore="$keystore" -PciKeystorePassword=pandoroid \
    -PciKeyAlias=pandoroid-ci -PciKeyPassword=pandoroid
apk=dist/pandoroid-$version-android-$abis.apk
cp build/outputs/apk/release/pandoroid-release.apk "$apk"

# 4. source tarball (includes the vendored melodica submodule checkout)
tar czf "dist/pandoroid-$version-src.tar.gz" \
    --exclude-vcs --exclude=./dist --exclude=./build --exclude=./libs \
    --exclude=./obj --exclude=./.gradle --exclude=./ci.keystore --exclude=./build.env \
    --transform "s,^\./,pandoroid-$version/," .

# 5. checksums
(cd dist && sha256sum -- * > SHA256SUMS)

printf 'version=%s\nabis=%s\napk=%s\n' "$version" "$abis" "$apk" | tee build.env
ls -l dist
