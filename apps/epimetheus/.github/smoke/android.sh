#!/usr/bin/env bash
# Android smoke test, run inside reactivecircus/android-emulator-runner (emulator booted, adb on PATH).
# Inputs: APK (path), OUT (dir). Optional tuner: TUNER_HTTPS_URL, TUNER_HTTP_URL, TUNER_CA, TUNER_USER, TUNER_PASSWORD, TUNER_LOG_URL.
set -uo pipefail
: "${APK:?}" "${OUT:?}"
mkdir -p "$OUT"
PKG=tk.hacker1024.epimetheus
ACT=io.flutter.embedding.android.FlutterActivity
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STEPS=()
NOTES=()
OK=false
TUNER=none
TUNER_RESULT="not attempted"
TUNER_WIRED=false
SDK=$(adb shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r'); SDK=${SDK:-unknown}

log() { printf '[smoke-android %s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$OUT/smoke-android-steps.txt"; }
step() { STEPS+=("$1"); log "step: $1"; }
note() { NOTES+=("$1"); log "note: $1"; }

finish() {
  local summary=$1
  python3 - "$OUT/smoke-android.json" "$OK" "$summary" "$NOW" "$TUNER" "$TUNER_RESULT" "$SDK" "${STEPS[@]}" <<'PY'
import json, sys
out, ok, summary, when, tuner, tuner_result, sdk, *steps = sys.argv[1:]
json.dump({"ok": ok == "true", "platform": "android", "summary": summary, "when": when,
           "steps": steps, "tuner": tuner, "tuner_result": tuner_result,
           "emulator": f"api-{sdk} x86_64 default (reactivecircus/android-emulator-runner@v2, swiftshader_indirect)",
           "detection": {"ui_dump": "uiautomator dump matched 'Email address'/'Password'/'Sign in' text",
                         "screenshot": "adb screencap, non-blank by ImageMagick standard-deviation",
                         "logcat": "Flutter engine lines in logcat"}}, open(out, "w"), indent=2)
PY
  cat "$OUT/smoke-android.json"
}

shot() { adb exec-out screencap -p > "$OUT/$1" 2>/dev/null; log "screenshot $1 ($(stat -c %s "$OUT/$1") bytes)"; }
stddev() { convert "$1" -colorspace Gray -format '%[fx:standard_deviation]' info: 2>>"$OUT/smoke-android-steps.txt" | head -1; }
dump_ui() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml 2>/dev/null; }

# Wait until a uiautomator dump contains any of the given strings (fixed-string grep); prints the dump file. Timeout in seconds.
wait_ui() {
  local timeout=$1 file=$2; shift 2
  local deadline=$((SECONDS + timeout))
  while [ $SECONDS -lt $deadline ]; do
    dump_ui > "$file"
    for s in "$@"; do grep -qF -- "$s" "$file" && { log "ui dump matched '$s' after wait"; return 0; }; done
    sleep 3
  done
  return 1
}

adb logcat -c || true
adb shell settings put global window_animation_scale 0; adb shell settings put global transition_animation_scale 0; adb shell settings put global animator_duration_scale 0
adb shell input keyevent 82 || true

# --- Optional tuner wiring: hosts + CA into the system partition (API 28 image, -writable-system) ---
# API 29+ images need a reboot after the first `adb remount` (overlayfs); that reboot hung adb in CI, so the
# emulator is an API 28 (Pie) x86_64 image where `adb root && adb remount` writes to /system straight away.
# DNS is overridden twice: /system/etc/hosts, and the emulator's -dns-server pointed at a resolver on the
# runner (.github/smoke/dns.py) that answers the pandora names with 10.0.2.2. Both are verified from inside
# the guest below; the job fails fast if the guest cannot reach the tuner's /__tuner/health.
if [ -n "${TUNER_HTTPS_URL:-}" ]; then
  TUNER=$(curl -sk "${TUNER_HTTP_URL:-$TUNER_HTTPS_URL}/__tuner/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' 2>/dev/null || echo unknown)
  log "tuner: $TUNER_HTTPS_URL version=$TUNER (ca=${TUNER_CA:-none})"
  log "guest: $(adb shell getprop ro.build.version.sdk | tr -d '\r') sdk, $(adb shell getprop ro.build.fingerprint | tr -d '\r')"
  adb root && sleep 3 && adb wait-for-device
  adb remount 2>&1 | tee -a "$OUT/smoke-android-steps.txt"
  if adb shell 'echo ok > /system/etc/.writetest' 2>/dev/null; then
    adb shell rm -f /system/etc/.writetest
    # Map the pandora names to the host (10.0.2.2). The tuner listens on 443/80 on the runner loopback.
    adb shell 'printf "127.0.0.1 localhost\n::1 ip6-localhost\n10.0.2.2 www.pandora.com tuner.pandora.com internal-tuner.pandora.com\n" > /system/etc/hosts'
    adb shell cat /system/etc/hosts | tee -a "$OUT/smoke-android-steps.txt"
    if [ -n "${TUNER_CA:-}" ]; then
      # Dart's BoringSSL loads /system/etc/security/cacerts as a hash directory; install under both hash spellings.
      for hash in $(openssl x509 -in "$TUNER_CA" -subject_hash -noout) $(openssl x509 -in "$TUNER_CA" -subject_hash_old -noout); do
        adb push "$TUNER_CA" "/system/etc/security/cacerts/$hash.0" >/dev/null
        adb shell chmod 644 "/system/etc/security/cacerts/$hash.0"
        adb shell ls -l "/system/etc/security/cacerts/$hash.0" | tee -a "$OUT/smoke-android-steps.txt"
      done
      note "tuner CA installed in /system/etc/security/cacerts (subject_hash and subject_hash_old names)"
    fi
    note "hosts: www.pandora.com tuner.pandora.com -> 10.0.2.2 (runner loopback, tuner on 443/80)"
  else
    note "system partition not writable after adb remount"
  fi
  adb unroot || true; sleep 3; adb wait-for-device
  # Proof from inside the guest: name resolution and an HTTP round trip to the tuner's health endpoint.
  PING=$(adb shell ping -c1 -W2 www.pandora.com 2>&1 | tr -d '\r' | head -2); log "guest ping: $PING"
  HEALTH=$(adb shell 'printf "GET /__tuner/health HTTP/1.0\r\nHost: www.pandora.com\r\n\r\n" | nc www.pandora.com 80' 2>&1 | tr -d '\r' | tail -1)
  log "guest http://www.pandora.com/__tuner/health -> $HEALTH"
  if printf '%s' "$PING" | grep -q '10\.0\.2\.2' && printf '%s' "$HEALTH" | grep -q '"ok"'; then
    step "guest reaches tuner (www.pandora.com -> 10.0.2.2, /__tuner/health ok)"
    [ -n "${TUNER_CA:-}" ] && adb shell ls /system/etc/security/cacerts/ | grep -q "$(openssl x509 -in "$TUNER_CA" -subject_hash_old -noout)" && TUNER_WIRED=true
    [ "$TUNER_WIRED" = true ] && step "tuner wired (hosts + system CA)"
  fi
  if [ "$TUNER_WIRED" != true ]; then
    adb logcat -d > "$OUT/smoke-android.txt"
    finish "the emulator guest could not be pointed at melodica-tuner (ping: ${PING//$'\n'/ } health: $HEALTH); no login attempted"; exit 1
  fi
fi

# --- Install ---
if adb install -r -t "$APK" 2>&1 | tee -a "$OUT/smoke-android-steps.txt" | grep -q Success; then
  step "installed"
else
  adb logcat -d > "$OUT/smoke-android.txt"
  finish "APK failed to install on the API-$SDK x86_64 emulator"; exit 1
fi
adb shell pm list packages | grep -q "$PKG" || { finish "package not present after install"; exit 1; }

# --- Open ---
adb shell am start -W -n "$PKG/$ACT" 2>&1 | tee -a "$OUT/smoke-android-steps.txt"
sleep 2
if adb shell dumpsys activity activities 2>/dev/null | grep -q "$PKG"; then step "opened"; else
  adb logcat -d > "$OUT/smoke-android.txt"; shot smoke-android-login.png
  finish "activity did not start"; exit 1
fi

# --- Login screen ---
LOGIN_OK=false
if wait_ui 90 "$OUT/smoke-android-ui.xml" "Email address" "Password" "Sign in"; then
  LOGIN_OK=true
  note "login screen detected via uiautomator dump (Flutter semantics)"
else
  note "uiautomator dump did not expose Flutter semantics within 90 s; falling back to screenshot variance + logcat"
fi
shot smoke-android-login.png
SD=$(stddev "$OUT/smoke-android-login.png"); log "login screenshot stddev=$SD"
if [ "$LOGIN_OK" != true ]; then
  # Blank frame or the static launch screen are low-variance; a rendered form (white card, outlined fields, app bar) is not.
  if python3 -c "import sys; sys.exit(0 if float('$SD' or 0) > 0.05 else 1)" && adb logcat -d | grep -qiE 'flutter|FlutterJNI|FlutterActivity'; then
    LOGIN_OK=true; note "login screen inferred from non-blank screenshot (stddev=$SD) + Flutter engine lines in logcat"
  fi
fi
adb shell dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity' | tee -a "$OUT/smoke-android-steps.txt" || true
if [ "$LOGIN_OK" = true ]; then step "login screen"; else
  adb logcat -d > "$OUT/smoke-android.txt"
  finish "APK installs and the activity starts, but the login screen was not detected (see smoke-android-ui.xml, screenshot, logcat)"; exit 1
fi

SUMMARY="APK installs on an API-$SDK x86_64 emulator and opens to the Sign in screen"
# --- Optional tuner login ---
if [ -n "${TUNER_HTTPS_URL:-}" ] && [ -n "${TUNER_USER:-}" ]; then
  if [ "$TUNER_WIRED" != true ]; then
    TUNER_RESULT="skipped: emulator could not be pointed at the tuner (system partition not writable), so no login was attempted"
    note "$TUNER_RESULT"
  elif grep -qF 'Email address' "$OUT/smoke-android-ui.xml"; then
    # Tap the fields by their bounds from the semantics dump, type with adb input.
    bounds() { python3 - "$OUT/smoke-android-ui.xml" "$1" <<'PY'
import re, sys
xml = open(sys.argv[1]).read(); label = sys.argv[2]
# The page title and the button can share a label ("Sign in"): prefer a clickable node, then any match.
matches = [n for n in re.findall(r'<node [^>]*>', xml) if f'text="{label}"' in n or f'content-desc="{label}"' in n]
for n in [n for n in matches if 'clickable="true"' in n] + matches:
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if b:
        x1,y1,x2,y2 = map(int, b.groups()); print((x1+x2)//2, (y1+y2)//2); break
PY
    }
    tap() { read -r x y < <(bounds "$1"); log "tap '$1' at ${x:-?},${y:-?}"; [ -n "${x:-}" ] && adb shell input tap "$x" "$y" && sleep 1; }
    typetext() { adb shell input text "$(printf '%s' "$1" | sed 's/ /%s/g')"; sleep 1; }
    tap "Email address"; typetext "$TUNER_USER"
    dump_ui > "$OUT/smoke-android-ui.xml"
    tap "Password"; typetext "$TUNER_PASSWORD"
    adb shell input keyevent 111 || true  # dismiss keyboard
    sleep 1; dump_ui > "$OUT/smoke-android-ui.xml"
    shot smoke-android-filled.png
    tap "Sign in"
    step "submitted credentials"
    DIALOGS=("Can't connect to Pandora." "You're outside the USA." "Incorrect email address or password." "An API error has occured." "Failed to use proxy.")
    wait_ui 90 "$OUT/smoke-android-ui.xml" "My Collection" "${DIALOGS[@]}"
    if grep -qF 'My Collection' "$OUT/smoke-android-ui.xml"; then
      step "logged in"
      # Station tiles come from station/getStations; wait for a fixture station name to be laid out.
      if wait_ui 60 "$OUT/smoke-android-ui.xml" "Aurora Fields" "Radio" "Shuffle"; then STATIONS_UI=true; else STATIONS_UI=false; fi
      shot smoke-android-stations.png
      grep -o 'text="[^"]*"' "$OUT/smoke-android-ui.xml" | sort -u | tr '\n' ' ' | tee -a "$OUT/smoke-android-steps.txt"; echo
    else
      shot smoke-android-stations.png
      STATIONS_UI=false
      DIALOG=""; for d in "${DIALOGS[@]}"; do grep -qF -- "$d" "$OUT/smoke-android-ui.xml" && DIALOG="$d" && break; done
      UI_TEXT=$(grep -oE '(text|content-desc)="[^"]+"' "$OUT/smoke-android-ui.xml" | sort -u | tr '\n' ' ')
      if [ -n "$DIALOG" ]; then
        TUNER_RESULT="login submitted; the app showed the dialog '$DIALOG' (HandshakeException maps to the USA dialog; see logcat)"
      else
        TUNER_RESULT="login submitted but the collection page was not detected within 90 s (ui: $UI_TEXT; see smoke-android-stations.png, logcat)"
      fi
      note "$TUNER_RESULT"
      adb logcat -d | grep -E ' (flutter|1024\.epimetheu|System\.err) *:' | grep -viE 'NoClassDefFound|WindowInsetsAnimation|^\s*$|at (void|android|io\.flutter)' | tail -40 | tee -a "$OUT/smoke-android-steps.txt"
    fi
    LOGIN_LOGGED=false; STATIONS_LOGGED=false
    if [ -n "${TUNER_LOG_URL:-}" ] && curl -sk "$TUNER_LOG_URL" -o "$OUT/smoke-android-tuner-log.json"; then
      read -r LOGIN_LOGGED STATIONS_LOGGED < <(python3 - "$OUT/smoke-android-tuner-log.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1])); entries = d if isinstance(d, list) else d.get("entries", d.get("log", []))
ok = lambda m: any(e.get("protocol") == "rest" and str(e.get("method", "")).endswith(m) and e.get("code") in (None, 0) for e in entries)
print(str(ok("auth/login")).lower(), str(ok("station/getStations")).lower())
PYEOF
)
      [ "$LOGIN_LOGGED" = true ] && step "auth/login ok (tuner log)"
      [ "$STATIONS_LOGGED" = true ] && step "station/getStations ok (tuner log)"
    fi
    if grep -qF 'My Collection' "$OUT/smoke-android-ui.xml" && [ "$STATIONS_LOGGED" = true ]; then
      step "station list"
      OK=true
      TUNER_RESULT="logged in; My Collection shown; tuner log has auth/login and station/getStations; station names in UI dump: $STATIONS_UI"
      SUMMARY="APK installs on an API-$SDK x86_64 emulator, opens to the Sign in screen, logs in against melodica-tuner $TUNER and lists stations"
    elif [ "$TUNER_RESULT" = "not attempted" ]; then
      TUNER_RESULT="collection page shown but station/getStations not confirmed in the tuner log (login logged: $LOGIN_LOGGED)"
    fi
  else
    TUNER_RESULT="skipped: login fields not addressable via semantics dump"
    note "$TUNER_RESULT"
  fi
fi

adb logcat -d > "$OUT/smoke-android.txt"
finish "$SUMMARY"
# Green job == ok:true (login through the tuner and station list). Anything less fails the job; the report is still uploaded.
[ "$OK" = true ]
