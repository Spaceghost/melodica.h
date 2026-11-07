#!/bin/bash
# Smoke-test the released APK on a running Android emulator (adb on PATH).
#
# Always produces, in $SMOKE_OUT (default smoke/):
#   smoke-android.json        machine-readable result
#   smoke-android.txt         step log + app logcat
#   smoke-android-login.png   screenshot of the login screen (when reached)
#   smoke-android-stations.png / smoke-android-playing.png (tuner mode only)
#
# Login-screen mode (default): install, launch, assert the login screen.
# Tuner mode (TUNER_URL, TUNER_USER, TUNER_PASSWORD set): additionally verify
# that the app's hardcoded host (www.pandora.com, http, port 80) resolves to
# the host-side tuner from inside the guest (the emulator must have been
# started with -dns-server -> tools/smoke-dns.py), log in, assert the station
# list, tap the first station.
#
# Exit status is non-zero when the asserted screens were not observed; the
# evidence files are written regardless so the release can carry them.
set -u

out=${SMOKE_OUT:-smoke}
mkdir -p "$out"
pkg=com.aregner.android.pandoid
activity=$pkg/.PandoidPlayer
apk=${SMOKE_APK:-$(ls dist/*.apk 2>/dev/null | head -n1)}
tuner_url=${TUNER_URL:-}
tuner_log_url=${TUNER_LOG_URL:-}
api_level=${SMOKE_API_LEVEL:-30}

steps=()
ok=false
summary="APK installs on an API-$api_level emulator and opens to the login screen"
tuner="none"
failure=""
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log() { printf '[smoke %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$out/smoke-android.txt"; }

write_result() {
    local steps_json
    steps_json=$(printf '"%s",' "${steps[@]}"); steps_json="[${steps_json%,}]"
    [ ${#steps[@]} -eq 0 ] && steps_json="[]"
    python3 - "$out/smoke-android.json" "$ok" "$summary" "$started" "$steps_json" "$tuner" "$failure" "$api_level" <<'PY'
import json, sys
p, ok, summary, when, steps, tuner, failure, api = sys.argv[1:]
d = {"ok": ok == "true", "platform": "android", "summary": summary, "when": when,
     "steps": json.loads(steps), "tuner": tuner,
     "emulator": {"api_level": int(api), "arch": "x86_64"}}
if failure:
    d["failure"] = failure
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
    log "result: ok=$ok steps=${steps[*]:-} tuner=$tuner${failure:+ failure=$failure}"
}

collect_logs() {
    {
        echo "===== logcat (app pid) ====="
        pid=$(adb shell pidof "$pkg" 2>/dev/null | tr -d '\r ')
        if [ -n "$pid" ]; then adb logcat -d -v threadtime --pid="$pid" 2>/dev/null; else echo "(no process)"; fi
        echo "===== logcat (AndroidRuntime / ActivityManager / pandoid) ====="
        adb logcat -d -v threadtime 2>/dev/null | grep -iE 'AndroidRuntime|pandoid|pandora|ActivityManager: (Start|Displayed|Force)' | tail -n 400
        if [ -n "$tuner_log_url" ]; then
            echo "===== tuner log ($tuner_log_url) ====="; curl -fsS "$tuner_log_url" 2>/dev/null; echo
        fi
    } >> "$out/smoke-android.txt" 2>&1
}

finish() {
    local code=$1
    [ -n "${2:-}" ] && failure=$2
    collect_logs
    write_result
    exit "$code"
}

dump_ui() {
    adb shell uiautomator dump /sdcard/smoke-ui.xml >/dev/null 2>&1 || return 1
    adb exec-out cat /sdcard/smoke-ui.xml 2>/dev/null
}

# wait_for_node <grep-regex> <seconds>: poll the UI hierarchy; leaves it in $ui
wait_for_node() {
    local pattern=$1 secs=$2 i
    for i in $(seq 1 "$secs"); do
        ui=$(dump_ui) || ui=""
        if printf '%s' "$ui" | grep -qE "$pattern"; then return 0; fi
        sleep 2
    done
    return 1
}

# center <resource-id>: "x y" of the first node with that id, from $ui
center() {
    printf '%s' "$ui" | python3 -c '
import re, sys
rid, xml = sys.argv[1], sys.stdin.read()
m = re.search(r"<node[^>]*resource-id=\"" + re.escape(rid) + r"\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", xml)
if not m: sys.exit(1)
x1, y1, x2, y2 = map(int, m.groups()); print((x1 + x2) // 2, (y1 + y2) // 2)
' "$1"
}

screenshot() { adb exec-out screencap -p > "$out/$1" 2>/dev/null && log "screenshot $1 ($(stat -c %s "$out/$1") bytes)"; }

: > "$out/smoke-android.txt"
log "apk=$apk tuner_url=${tuner_url:-none}"
[ -f "$apk" ] || finish 2 "apk not found"

# --- device ready ----------------------------------------------------------
adb wait-for-device
for i in $(seq 1 60); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
    sleep 5
done
log "boot_completed=$(adb shell getprop sys.boot_completed | tr -d '\r') sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r') $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
adb shell input keyevent 82 >/dev/null 2>&1 || true
adb shell settings put global window_animation_scale 0 >/dev/null 2>&1 || true

# --- www.pandora.com (http, port 80) must resolve to the host ---------------
# The emulator was started with -dns-server pointing at tools/smoke-dns.py,
# which answers www.pandora.com with 10.0.2.2 (the host). A hosts file bind-
# mounted over /system/etc/hosts is NOT honoured by the guest resolver (run
# 42278354776), so the mapping is verified from inside the guest before the
# app is launched and the test fails fast if it is not in effect.
# Tuner mode implies the check; SMOKE_MAP_HOST=1 runs the check alone.
map_host=${SMOKE_MAP_HOST:-}
[ -n "$tuner_url" ] && map_host=1
host_probe="skipped"
if [ -n "$map_host" ]; then
    if [ -n "$tuner_url" ]; then
        health=$(curl -fsS "$tuner_url/__tuner/health" 2>/dev/null || echo '{}')
        tuner=$(printf '%s' "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("version") or "unknown")' 2>/dev/null || echo unknown)
        log "tuner at $tuner_url: $health"
    fi
    log "emulator dns: net.dns1=$(timeout 30 adb shell getprop net.dns1 | tr -d '\r') net.dns2=$(timeout 30 adb shell getprop net.dns2 | tr -d '\r')"
    resolved=$(timeout 30 adb shell "ping -c1 -W2 www.pandora.com 2>&1" | tr -d '\r' | head -n1)
    log "emulator resolves www.pandora.com: $resolved"
    http=$(timeout 30 adb shell "printf 'GET /__tuner/health HTTP/1.0\r\nHost: www.pandora.com\r\n\r\n' | toybox nc -w 5 www.pandora.com 80 2>&1" | tr -d '\r' | head -n 20)
    { echo "===== emulator GET http://www.pandora.com/__tuner/health ====="; printf '%s\n' "$http"; } >> "$out/smoke-android.txt"
    if printf '%s' "$http" | grep -q '^HTTP/' && printf '%s' "$resolved" | grep -q '(10\.0\.2\.2)'; then
        host_probe="reachable: $(printf '%s' "$http" | head -n1)"
        if [ -n "$tuner_url" ]; then
            if printf '%s' "$http" | grep -q '"ok":true'; then
                host_probe="$host_probe, tuner health served to the guest"
            else
                host_probe="not the tuner: $(printf '%s' "$http" | head -n1)"
            fi
        fi
    elif printf '%s' "$resolved" | grep -q '(10\.0\.2\.2)'; then
        host_probe="resolved to 10.0.2.2 but unreachable: $(printf '%s' "$http" | head -n1)"
    else
        host_probe="not resolved to the host: $resolved"
    fi
    log "emulator -> http://www.pandora.com:80 $host_probe"
    case $host_probe in
        reachable*) ;;
        *) [ -n "$tuner_url" ] && finish 8 "emulator cannot reach the tuner as www.pandora.com ($host_probe)";;
    esac
fi

# --- install + launch --------------------------------------------------------
adb logcat -c >/dev/null 2>&1 || true
adb uninstall "$pkg" >/dev/null 2>&1 || true
inst=$(adb install -r "$apk" 2>&1 | tr -d '\r'); log "adb install: $inst"
printf '%s' "$inst" | grep -q Success || finish 3 "install failed"
steps+=(installed)
log "package: $(adb shell pm list packages | tr -d '\r' | grep -F "$pkg")"

adb shell am start -W -n "$activity" 2>&1 | tr -d '\r' | sed 's/^/[am] /' | tee -a "$out/smoke-android.txt"
sleep 5
if ! wait_for_node "$pkg" 30; then
    screenshot smoke-android-login.png
    finish 4 "app window not shown"
fi
steps+=(opened)

# --- login screen ------------------------------------------------------------
if ! wait_for_node "resource-id=\"$pkg:id/login_button\"" 30; then
    screenshot smoke-android-login.png
    finish 5 "login screen not shown"
fi
missing=""
for id in login_welcome login_username login_password login_button; do
    printf '%s' "$ui" | grep -q "resource-id=\"$pkg:id/$id\"" || missing="$missing $id"
done
printf '%s' "$ui" | grep -q 'text="Welcome to Pandoroid Radio"' || missing="$missing welcome-text"
printf '%s' "$ui" | grep -q 'text="Login"' || missing="$missing login-text"
screenshot smoke-android-login.png
[ -z "$missing" ] || finish 6 "login screen incomplete:$missing"
log "login screen: login_welcome/login_username/login_password/login_button present"
steps+=("login screen")

if [ -z "$tuner_url" ]; then
    if [ -n "$map_host" ]; then
        summary="$summary; www.pandora.com mapped to the host inside the emulator ($host_probe)"
        case $host_probe in reachable*) steps+=("host mapped"); ok=true; finish 0;; *) finish 8 "host mapping probe failed: $host_probe";; esac
    fi
    ok=true
    finish 0
fi

# --- tuner mode: log in ------------------------------------------------------
tap() { adb shell input tap $1 >/dev/null; sleep 1; }
type_text() { adb shell input text "$(printf '%s' "$1" | sed 's/ /%s/g')" >/dev/null; sleep 1; }
tap "$(center "$pkg:id/login_username")"; type_text "$TUNER_USER"
tap "$(center "$pkg:id/login_password")"; type_text "$TUNER_PASSWORD"
adb shell input keyevent 111 >/dev/null 2>&1 || true   # ESC: close IME if open
sleep 1
ui=$(dump_ui)
tap "$(center "$pkg:id/login_button")"
log "submitted credentials for $TUNER_USER"

if ! wait_for_node "resource-id=\"$pkg:id/stations_name\"" 60; then
    screenshot smoke-android-stations.png
    finish 7 "station list not shown after login"
fi
names=$(printf '%s' "$ui" | grep -o "text=\"[^\"]*\" resource-id=\"$pkg:id/stations_name\"" | sed 's/ resource-id.*//; s/text=//')
log "station list shown: $(printf '%s' "$names" | tr '\n' ' ')"
screenshot smoke-android-stations.png
printf '%s' "$names" | grep -q 'Radio' || finish 7 "station list has no fixture station names: $names"
steps+=("logged in" "stations listed")
tuner_log_has() { # <protocol> <method-or-empty>: a logged request with no error code
    curl -fsS "$tuner_log_url" 2>/dev/null | python3 -c '
import json, sys
proto, method = sys.argv[1], sys.argv[2]
ok = [e for e in json.load(sys.stdin)
      if e.get("protocol") == proto and (not method or e.get("method") == method)
      and e.get("code") is None and int(e.get("status", 0)) < 400]
sys.exit(0 if ok else 1)' "$1" "$2"
}
if [ -n "$tuner_log_url" ]; then
    tuner_log_has xmlrpc listener.authenticateListener || finish 9 "station list shown but the tuner log has no successful listener.authenticateListener"
    tuner_log_has xmlrpc station.getStations || finish 9 "station list shown but the tuner log has no successful station.getStations"
    log "tuner log: xmlrpc listener.authenticateListener and station.getStations served"
fi
summary="APK installs on an API-$api_level emulator, opens to the login screen, logs in to the melodica-tuner test server and lists its stations"
ok=true

# --- tap the first station ---------------------------------------------------
first=$(printf '%s' "$ui" | python3 -c '
import re, sys
xml = sys.stdin.read()
m = re.search(r"<node[^>]*resource-id=\"[^\"]*:id/stations_name\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", xml)
if m:
    x1, y1, x2, y2 = map(int, m.groups()); print((x1 + x2) // 2, (y1 + y2) // 2)
')
if [ -n "$first" ]; then
    tap "$first"
    if wait_for_node "resource-id=\"$pkg:id/player_topText\" text=\"[^\"]+ by [^\"]+\"" 60 \
       || wait_for_node "text=\"[^\"]+ by [^\"]+\"[^>]*resource-id=\"$pkg:id/player_topText\"" 5; then
        screenshot smoke-android-playing.png
        now=$(printf '%s' "$ui" | grep -o "text=\"[^\"]* by [^\"]*\"" | head -n1)
        log "player screen: $now"
        if [ -n "$tuner_log_url" ] && tuner_log_has xmlrpc playlist.getFragment && tuner_log_has audio ""; then
            steps+=(playing); summary="$summary, and plays the first station (playlist.getFragment + audio fetch served)"
            log "tuner log: playlist.getFragment and an audio fetch served"
        else
            log "player screen shown but no audio fetch seen in the tuner log"
        fi
    else
        screenshot smoke-android-playing.png
        log "first station tapped; no player screen with a song within 60s (not counted)"
    fi
fi
finish 0
