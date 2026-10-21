#!/bin/sh
# Run inside a disposable Fedora or Ubuntu/Debian worker.
set -eu
case "$(uname -s):$(uname -m)" in Linux:x86_64) ;; *) echo 'CI requires Linux x86_64' >&2; exit 64;; esac
case "${1:-}" in native|reference) mode=$1;; *) echo 'usage: ci-deps.sh native|reference' >&2; exit 64;; esac
as_root() {
    if [ "$(id -u)" = 0 ]; then "$@"
    elif command -v doas >/dev/null; then doas -n "$@"
    else sudo -n "$@"; fi
}
[ ! -e /run/ostree-booted ] || {
    echo 'Use an Incus build worker; do not install build dependencies on the Atomic host' >&2
    exit 69
}
if command -v dnf >/dev/null; then
    as_root dnf -y --disable-repo=fedora-cisco-openh264 --setopt=install_weak_deps=False install \
        ca-certificates git curl xz tar gzip patch gcc gcc-c++ make clang compiler-rt llvm lld \
        binutils pkgconf-pkg-config python3 readline-devel tmux json-c-devel libgcrypt-devel
    if [ "$mode" = reference ]; then
        as_root dnf -y --disable-repo=fedora-cisco-openh264 --setopt=install_weak_deps=False install \
            libcurl-devel libao-devel libavcodec-free-devel libavformat-free-devel \
            libavutil-free-devel libavfilter-free-devel
    fi
    exit 0
fi
command -v apt-get >/dev/null || { echo 'Use a Fedora or Ubuntu/Debian Incus worker' >&2; exit 69; }
as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git curl xz-utils patch build-essential clang llvm lld binutils \
    pkg-config python3 libreadline-dev tmux libgcrypt20-dev libjson-c-dev
if [ "$mode" = reference ]; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libcurl4-openssl-dev libgcrypt20-dev libjson-c-dev libao-dev \
        libavcodec-dev libavformat-dev libavutil-dev libavfilter-dev
fi
