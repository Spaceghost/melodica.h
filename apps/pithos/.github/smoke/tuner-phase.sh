# Phase B of smoke-linux.sh (sourced): log in against melodica-tuner, list
# stations and start playback. Inputs (env, from the Spaceghost/melodica-tuner
# action outputs): TUNER_HTTPS_URL, TUNER_HTTP_URL, TUNER_CA_PATH, TUNER_USER,
# TUNER_PASSWORD, TUNER_LOG_URL.
#
# How Pithos is pointed at the tuner:
#  * Pithos hard-codes rpcUrl "://tuner.pandora.com/services/json/?" and uses
#    it for plain-http and https calls alike (pithos/pandora/data.py,
#    json_call in pandora.py). The tuner action's hosts-override maps
#    tuner.pandora.com to 127.0.0.1 and the tuner listens on 443 and 80;
#    the Flatpak sandbox shares the host's /etc/hosts, so no setting in
#    Pithos changes. (The `force-client` GSettings key could carry another
#    rpcUrl, but one host string must serve both http and https anyway.)
#  * TLS: Pithos builds its urllib opener with ssl.create_default_context(),
#    which honours SSL_CERT_FILE. The runtime's CA bundle, not the host's
#    trust store, is what the sandbox sees, so the tuner CA is copied into
#    the app's data dir (same path inside and outside the sandbox) and
#    passed with --env=SSL_CERT_FILE. Audio and art URLs are plain http.
#  * Credentials: Pithos stores the password in libsecret under the schema
#    io.github.Pithos.Account {email} and reads the account from the `email`
#    GSettings key. A gnome-keyring-daemon with a blank login keyring runs
#    on the dbus-run-session bus, the secret is seeded with secret-tool, and
#    the sandbox is started with --talk-name=org.freedesktop.secrets so
#    libsecret inside talks to that Secret Service (there is no secrets
#    portal on the runner). Pithos then logs in by itself at start-up.
TUNER=$(curl -fsS --cacert "$TUNER_CA_PATH" "$TUNER_HTTPS_URL/__tuner/health" | jq -r '.version // "unknown"' 2>/dev/null || echo unknown)
echo "tuner version: $TUNER"
rm -rf "$APPDATA"
mkdir -p "$APPDATA/data"
cp "$TUNER_CA_PATH" "$APPDATA/data/tuner-ca.pem"

gs() { flatpak run --command=gsettings "$APP" set io.github.Pithos "$@"; }
gs email "$TUNER_USER"
gs pandora-one false
echo "gsettings email: $(flatpak run --command=gsettings "$APP" get io.github.Pithos email)"

# Keyring: a keyring whose password is blank is stored in gnome-keyring's
# plain-text format and loads unlocked, so nothing ever prompts. (The
# previous approach, `gnome-keyring-daemon --unlock` fed an empty password,
# activated org.gnome.keyring.SystemPrompter and hung the job for 6 h until
# GitHub cancelled it.) Every keyring call is bounded by `timeout` so a
# regression fails the step instead of hanging it.
KEYRINGS=$HOME/.local/share/keyrings
mkdir -p -m 700 "$KEYRINGS"
printf 'login\n' >"$KEYRINGS/default"
cat >"$KEYRINGS/login.keyring" <<'KEYRING'
[keyring]
display-name=login
ctime=0
mtime=0
lock-on-idle=false
lock-after=false
KEYRING
gnome-keyring-daemon --foreground --components=secrets >"$OUT/keyring.log" 2>&1 &
KEYRING_PID=$!
for _ in $(seq 1 30); do
  if timeout 5 gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
       --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>/dev/null | grep -q true; then
    break
  fi
  sleep 1
done
echo "keyring: daemon pid $KEYRING_PID; secrets owner: $(timeout 5 gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>&1)"
printf '%s' "$TUNER_PASSWORD" | timeout 30 secret-tool store --label="Pithos smoke account" \
  xdg:schema io.github.Pithos.Account email "$TUNER_USER" \
  || fail "secret-tool store failed or timed out (rc=$?)"
if [ -z "$FAIL_REASON" ]; then
  if [ "$(timeout 30 secret-tool lookup xdg:schema io.github.Pithos.Account email "$TUNER_USER")" = "$TUNER_PASSWORD" ]; then
    echo "keyring: account secret seeded"
    step "account seeded"
  else
    fail "could not seed the account password in gnome-keyring"
  fi
fi

status=""; pos1=""; pos2=""
if [ -z "$FAIL_REASON" ]; then
  flatpak run --talk-name=org.freedesktop.secrets \
    --env=SECRET_BACKEND=service \
    --env=SSL_CERT_FILE="$APPDATA/data/tuner-ca.pem" \
    --env=GST_DEBUG=2 \
    "$APP" --debug >"$OUT/pithos-stations.log" 2>&1 &

  # With an account configured the app logs in at once and the title goes
  # straight from "Pithos" to "<song> by <artist> - Pithos", so wait for
  # either form here and for the playing form below.
  if ! wait_window 'Pithos$' 90; then
    import -window root "$OUT/smoke-linux-stations.png" 2>/dev/null || true
    fail "main window did not appear (tuner phase)"
  elif ! wait_window ' - Pithos$' 150; then
    arrange_windows
    import -window root "$OUT/smoke-linux-stations.png"
    window_names | tee "$OUT/windows-stations.txt"
    fail "window title never changed to '<song> by <artist> - Pithos' within 150s"
  fi
fi

if [ -z "$FAIL_REASON" ]; then
  if grep -q "Pandora connected" "$OUT/pithos-stations.log"; then
    step "logged in"
  else
    fail "'Pandora connected' not logged"
  fi
fi
if [ -z "$FAIL_REASON" ]; then
  if grep -q "Selecting station" "$OUT/pithos-stations.log"; then
    step "stations listed"
  else
    fail "'Selecting station' not logged"
  fi
fi
if [ -z "$FAIL_REASON" ]; then
  # Playback: MPRIS (plugin on by default; flatpak lets the app own
  # org.mpris.MediaPlayer2.<app-id>) must report Playing and a position that
  # advances. The sandbox has no audio device, so autoaudiosink falls back
  # to a fakesink; the pipeline clock still runs.
  mpris() {
    gdbus call --session --dest org.mpris.MediaPlayer2.io.github.Pithos \
      --object-path /org/mpris/MediaPlayer2 \
      --method org.freedesktop.DBus.Properties.Get org.mpris.MediaPlayer2.Player "$1" 2>/dev/null
  }
  for _ in $(seq 1 30); do
    status=$(mpris PlaybackStatus)
    case "$status" in *Playing*) break ;; esac
    sleep 1
  done
  # The tuner's clips are ~10 s long, so sample the position a few times
  # and accept any advance between two consecutive samples (a track change
  # in between resets it).
  advanced=false
  pos1=$(mpris Position | grep -oE 'int64 [0-9]+' | awk '{print $2}')
  for _ in $(seq 1 8); do
    sleep 1
    pos2=$(mpris Position | grep -oE 'int64 [0-9]+' | awk '{print $2}')
    if [ "${pos2:-0}" -gt "${pos1:-0}" ]; then advanced=true; break; fi
    pos1=$pos2
  done
  arrange_windows
  import -window root "$OUT/smoke-linux-stations.png"
  echo "mpris: status=$status position=${pos1:-?} -> ${pos2:-?} advanced=$advanced"
  window_names | tee "$OUT/windows-stations.txt"
  if [[ "$status" == *Playing* ]] && [ "$advanced" = true ]; then
    step "playing"
  else
    fail "MPRIS did not report Playing with an advancing position (status=$status pos=$pos1->$pos2)"
  fi
fi

# Server-side evidence from the tuner request log.
curl -fsS --cacert "$TUNER_CA_PATH" "$TUNER_LOG_URL" >"$OUT/tuner-log.json" 2>"$OUT/tuner-log.err" \
  || curl -fsS "$TUNER_LOG_URL" >"$OUT/tuner-log.json" 2>>"$OUT/tuner-log.err" || true
TUNER_EVIDENCE=$(python3 -I "$HERE/tuner_evidence.py" "$OUT/tuner-log.json" "$status" "${pos1:-?}->${pos2:-?}" \
  | tee "$OUT/tuner-log.txt" | tail -n 1)
echo "tuner evidence: $TUNER_EVIDENCE"
for m in auth.userLogin user.getStationList station.getPlaylist; do
  if [ "$(printf '%s' "$TUNER_EVIDENCE" | jq --arg m "$m" '.[$m] // 0')" -gt 0 ]; then
    STEPS+=("$m ok")
  elif [ -z "$FAIL_REASON" ]; then
    fail "tuner log has no $m request"
  fi
done
if [ "$(printf '%s' "$TUNER_EVIDENCE" | jq '.audio_requests // 0')" -gt 0 ]; then
  STEPS+=("audio fetched")
elif [ -z "$FAIL_REASON" ]; then
  fail "tuner log has no audio request"
fi
stop_app
kill "$KEYRING_PID" 2>/dev/null || true
