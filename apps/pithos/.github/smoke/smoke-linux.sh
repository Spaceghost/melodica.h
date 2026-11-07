#!/usr/bin/env bash
# Smoke test for the released Pithos Flatpak bundle.
#
# Runs on a plain Ubuntu runner inside `xvfb-run ... dbus-run-session`
# (see .github/workflows/release.yml). The bundle must already be installed
# (`flatpak install --user`). Produces, in $SMOKE_OUT:
#   smoke-linux-login.png     screenshot of the first start: main window + login dialog
#   smoke-linux-stations.png  screenshot after logging in against melodica-tuner (phase B)
#   smoke-linux.json          machine-readable result (ok, steps, tuner evidence)
#   smoke-linux.txt           human-readable report
#   pithos-*.log              Pithos debug output per phase
#
# Phase A (always): start the app with no account configured and assert that
# the main window and the Preferences (login) dialog appear.
#
# Phase B (when TUNER_HTTPS_URL is set): point Pithos at melodica-tuner, seed
# the account, start it again and assert login -> station list -> playback.
set -uo pipefail

APP=io.github.Pithos
OUT=${SMOKE_OUT:-$PWD/smoke}
mkdir -p "$OUT"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPDATA=$HOME/.var/app/$APP

STEPS=()
OK=false
FAIL_REASON=""
step() { STEPS+=("$1"); echo "== step: $1"; }
fail() { FAIL_REASON=$1; echo "!! $1" >&2; }

window_names() {
  local w
  for w in $(xdotool search --onlyvisible --name '.' 2>/dev/null); do
    printf '%s\t%s\n' "$w" "$(xdotool getwindowname "$w" 2>/dev/null)"
  done
}

# wait_window <regex> <seconds>
wait_window() {
  local i
  for ((i = 0; i < $2; i++)); do
    if xdotool search --onlyvisible --name "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# No window manager runs under Xvfb, so windows stack in mapping order and
# overlap at the origin. Spread them out and raise dialogs so a screenshot
# shows every window.
arrange_windows() {
  local main dlg i=0
  for main in $(xdotool search --onlyvisible --name '^Pithos$|- Pithos$' 2>/dev/null); do
    xdotool windowmove "$main" 20 20 2>/dev/null || true
  done
  for dlg in $(xdotool search --onlyvisible --name '^Preferences$' 2>/dev/null); do
    xdotool windowmove "$dlg" $((640 + i * 20)) $((60 + i * 20)) windowraise "$dlg" 2>/dev/null || true
    i=$((i + 1))
  done
  sleep 1
}

stop_app() {
  flatpak kill "$APP" 2>/dev/null || true
  sleep 2
}

# ---------------------------------------------------------------- phase A
echo "## phase A: first start, no account"
rm -rf "$APPDATA"
flatpak run "$APP" --debug >"$OUT/pithos-login.log" 2>&1 &
step "installed"

if wait_window '^Pithos$' 90; then
  step "opened"
else
  fail "main window 'Pithos' did not appear within 90s"
fi

if [ -z "$FAIL_REASON" ]; then
  if wait_window '^Preferences$' 60; then
    sleep 8
    arrange_windows
    import -window root "$OUT/smoke-linux-login.png"
    step "login dialog"
  else
    sleep 2
    import -window root "$OUT/smoke-linux-login.png"
    fail "Preferences (login) dialog did not appear within 60s"
  fi
fi
window_names | tee "$OUT/windows-login.txt"
stop_app

# ---------------------------------------------------------------- phase B
TUNER="none"
TUNER_EVIDENCE="{}"
if [ -z "$FAIL_REASON" ] && [ -n "${TUNER_HTTPS_URL:-}" ]; then
  echo "## phase B: log in against melodica-tuner at $TUNER_HTTPS_URL"
  # shellcheck source=/dev/null
  . "$HERE/tuner-phase.sh"
fi

# ---------------------------------------------------------------- report
[ -z "$FAIL_REASON" ] && OK=true
SUMMARY="flatpak installs and opens to the login dialog"
if [ "$TUNER" != "none" ] && [ "$OK" = true ]; then
  SUMMARY="flatpak installs, opens, logs in against melodica-tuner, lists stations and starts playing"
fi

python3 -I "$HERE/report.py" \
  --out "$OUT/smoke-linux.json" \
  --ok "$OK" \
  --summary "$SUMMARY" \
  --tuner "$TUNER" \
  --evidence "$TUNER_EVIDENCE" \
  --failure "$FAIL_REASON" \
  --version "${VERSION:-unknown}" \
  --steps "${STEPS[@]}"

{
  echo "Pithos ${VERSION:-unknown} Flatpak smoke test (linux x86_64, Xvfb)"
  echo "ok: $OK"
  echo "steps: ${STEPS[*]}"
  [ -n "$FAIL_REASON" ] && echo "failure: $FAIL_REASON"
  echo "tuner: $TUNER"
  echo
  echo "--- windows after first start (login phase)"
  cat "$OUT/windows-login.txt"
  if [ -f "$OUT/windows-stations.txt" ]; then
    echo
    echo "--- windows after login (stations phase)"
    cat "$OUT/windows-stations.txt"
  fi
  if [ -f "$OUT/tuner-log.txt" ]; then
    echo
    echo "--- melodica-tuner request log"
    cat "$OUT/tuner-log.txt"
  fi
  echo
  echo "--- pithos-login.log (tail)"
  tail -n 40 "$OUT/pithos-login.log"
  if [ -f "$OUT/pithos-stations.log" ]; then
    echo
    echo "--- pithos-stations.log (tail)"
    tail -n 60 "$OUT/pithos-stations.log"
  fi
} >"$OUT/smoke-linux.txt"
cat "$OUT/smoke-linux.txt"
cat "$OUT/smoke-linux.json"

[ "$OK" = true ]
