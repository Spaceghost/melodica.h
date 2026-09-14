#!/bin/bash
# Immutable language pins retained from the original comparison workflow.
set -euo pipefail
ODIN_VERSION=dev-2026-09
ODIN_SHA256=167c3e1d7056419dad2e04bb3bd98715b7ff286d4c125f3c5a5ee337c6254283
ZIG_VERSION=0.16.0
ZIG_SHA256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
NELUA_REV=a58450563e2d2ec49bff499865c8b5cfdf6ff81a
fetch() {
    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 \
        --max-time 300 --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" -o "$2"
}
if [ "${1:-}" = --install ]; then
    lane=$2
    dest=$3
    case "$lane" in
    odin)
        fetch "https://github.com/odin-lang/Odin/releases/download/$ODIN_VERSION/odin-linux-amd64-$ODIN_VERSION.tar.gz" "$dest/odin.tar.gz"
        printf '%s  %s\n' "$ODIN_SHA256" "$dest/odin.tar.gz" | sha256sum -c -
        mkdir "$dest/odin"
        tar -xzf "$dest/odin.tar.gz" -C "$dest/odin" --strip-components=1
        "$dest/odin/odin" version
        ;;
    zig)
        fetch "https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz" "$dest/zig.tar.xz"
        printf '%s  %s\n' "$ZIG_SHA256" "$dest/zig.tar.xz" | sha256sum -c -
        mkdir "$dest/zig"
        tar -xJf "$dest/zig.tar.xz" -C "$dest/zig" --strip-components=1
        "$dest/zig/zig" version
        ;;
    nelua)
        git init "$dest/nelua"
        git -C "$dest/nelua" remote add origin https://github.com/edubart/nelua-lang.git
        git -C "$dest/nelua" fetch --depth=1 origin "$NELUA_REV"
        git -C "$dest/nelua" checkout --detach FETCH_HEAD
        test "$(git -C "$dest/nelua" rev-parse HEAD)" = "$NELUA_REV"
        make -C "$dest/nelua" -j2
        test -x "$dest/nelua/nelua-lua"
        "$dest/nelua/nelua" --version
        ;;
    *) exit 64;;
    esac
    exit 0
fi
: "${GITHUB_ENV:?Run this from CI; local users can use the pinned tools directly}"
: "${GITHUB_PATH:?}"
dest=$(mktemp -d "$RUNNER_TEMP/melodica-toolchains.XXXXXX")
mkdir -p build/toolchain-evidence
# Explicit paths prevent accidentally falling back to unrelated preinstalled versions.
printf 'ODIN=%s/odin/odin\nZIG=%s/zig/zig\nNELUA=%s/nelua/nelua\n' "$dest" "$dest" "$dest" >> "$GITHUB_ENV"
printf '%s/odin\n%s/zig\n%s/nelua\n' "$dest" "$dest" "$dest" >> "$GITHUB_PATH"
status=0
for lane in odin zig nelua; do
    # Each install is a fresh process so one failed download does not hide other lanes.
    if bash "$0" --install "$lane" "$dest" > "build/toolchain-evidence/$lane.log" 2>&1; then
        printf '%s: installed\n' "$lane"
    else
        printf '%s: install failed\n' "$lane" >&2
        status=1
    fi
    cat "build/toolchain-evidence/$lane.log"
done
exit "$status"
