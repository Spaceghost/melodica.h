#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v ndk-build >/dev/null 2>&1; then
    echo "ndk-build is required (install the Android NDK and add it to PATH)" >&2
    exit 127
fi

exec ndk-build -C "$project_dir" \
    NDK_PROJECT_PATH="$project_dir" \
    APP_BUILD_SCRIPT="$project_dir/jni/Android.mk" \
    NDK_APPLICATION_MK="$project_dir/jni/Application.mk" "$@"
