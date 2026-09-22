#!/bin/sh
# This runs inside an Ubuntu job worker, never as a host installer on Alpine.
set -eu
case "$(uname -s):$(uname -m)" in Linux:x86_64) ;; *) echo 'CI requires Linux x86_64' >&2; exit 64;; esac
command -v apt-get >/dev/null || { echo 'Use the Ubuntu Incus worker, not the Alpine host' >&2; exit 69; }
case "${1:-}" in native|reference) mode=$1;; *) echo 'usage: ci-deps.sh native|reference' >&2; exit 64;; esac
as_root() {
    if [ "$(id -u)" = 0 ]; then "$@"
    elif command -v doas >/dev/null; then doas -n "$@"
    else sudo -n "$@"; fi
}
as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git curl xz-utils build-essential clang llvm lld binutils \
    pkg-config python3 libreadline-dev tmux
if [ "$mode" = reference ]; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libcurl4-openssl-dev libgcrypt20-dev libjson-c-dev libao-dev \
        libavcodec-dev libavformat-dev libavutil-dev libavfilter-dev
fi
