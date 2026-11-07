#!/usr/bin/env bash
# Simulator proof for the iOS build: boot an iPhone simulator, install the app,
# launch it, check that the system registered the Safari extension, open Safari,
# and write tests/artifacts/smoke-ios.json plus smoke-ios-*.png.
#
#   ios/scripts/sim-smoke.sh <path/to/melodica.app> <version>
# env: TUNER_HTTPS_URL TUNER_HTTP_URL TUNER_CA (from Spaceghost/melodica-tuner@v1), optional.
#
# What it proves: the app installs and launches on the simulator, pluginkit lists the
# extension, and once switched on (Safari's Extensions.plist, as Settings stores it) its
# content script runs on spacegho.st/melodica/app/ (the page's status line, read by OCR).
# What it cannot: open the popup or the player (that needs a tap in Safari's extensions
# menu), so the tuner login and playback on iOS are not exercised (ios/README.md).
set -uo pipefail
app="$1"; version="$2"
art="${ART:-tests/artifacts}"; mkdir -p "$art"
steps="$art/smoke-ios-steps.jsonl"; : > "$steps"
step() { # name ok detail
  node -e 'const [n,ok,d]=process.argv.slice(1); console.log(JSON.stringify({name:n, ok:ok==="true", detail:d}))' "$1" "$2" "$3" >> "$steps"
  echo "step $1: $2 :: $3"
}
appid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
appex="$(ls -d "$app"/PlugIns/*.appex | head -1)"
extid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$appex/Info.plist")"

# The newest iOS runtime, its first iPhone.
read -r udid devname runtime < <(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]
rts=sorted([k for k in d if "iOS" in k], key=lambda k:[int(x) for x in re.findall(r"\d+",k)])
for rt in reversed(rts):
  for dev in d[rt]:
    if dev["name"].startswith("iPhone"):
      print(dev["udid"], dev["name"].replace(" ","_"), rt.split(".")[-1]); sys.exit()
')
[ -n "${udid:-}" ] || { step boot false "no iPhone simulator available"; udid=""; }
if [ -n "$udid" ]; then
  xcrun simctl boot "$udid" 2>/dev/null; xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1
  step boot true "$devname $runtime ($udid)"
  if xcrun simctl install "$udid" "$app"; then step install true "$appid with $extid"; else step install false "simctl install failed"; fi
  if xcrun simctl launch "$udid" "$appid"; then
    sleep 8
    xcrun simctl io "$udid" screenshot "$art/smoke-ios-app.png" >/dev/null 2>&1
    step launch true "$appid launched; screenshot smoke-ios-app.png"
  else
    step launch false "simctl launch failed"
  fi
  pk="$(xcrun simctl spawn "$udid" pluginkit -mAvvv -i "$extid" 2>&1 | head -20)"
  echo "$pk"
  if grep -q "$extid" <<<"$pk"; then step pluginkit true "$(tr '\n' ' ' <<<"$pk" | sed 's/  */ /g' | cut -c1-400)"
  else step pluginkit false "pluginkit does not list $extid: $(tr '\n' ' ' <<<"$pk" | cut -c1-200)"; fi
  if [ -n "${TUNER_CA:-}" ] && [ -s "$TUNER_CA" ]; then
    xcrun simctl keychain "$udid" add-root-cert "$TUNER_CA" && step tuner-ca true "melodica-tuner CA added to the simulator keychain" || step tuner-ca false "add-root-cert failed"
  fi
  if [ -n "${TUNER_HTTP_URL:-}" ]; then
    xcrun simctl openurl "$udid" "${TUNER_HTTP_URL%/}/" && sleep 10
    xcrun simctl io "$udid" screenshot "$art/smoke-ios-safari.png" >/dev/null 2>&1
    step safari true "Safari opened ${TUNER_HTTP_URL%/}/ (melodica-tuner); screenshot smoke-ios-safari.png"
  fi
  data="$(xcrun simctl getenv "$udid" HOME 2>/dev/null || echo "$HOME/Library/Developer/CoreSimulator/Devices/$udid/data")"
  # Turn the extension on the way Settings does: Safari keeps per-extension state in
  # Library/Safari/WebExtensions/Extensions.plist in its data container (found by the
  # first run's discovery: one entry "<extension id> (<team>)" with AccessibleOrigins and
  # Permissions, and no Enabled key until the user turns it on). With Safari stopped,
  # set Enabled and grant the requested origins and permissions, then start Safari again.
  plist="$(find "$data/Containers/Data/Application" -path '*Library/Safari/WebExtensions/Extensions.plist' 2>/dev/null | head -1)"
  { echo "== Extensions.plist before =="; [ -n "$plist" ] && plutil -p "$plist"; } > "$art/smoke-ios-discovery.txt" 2>&1
  enabled=false
  if [ -n "$plist" ]; then
    xcrun simctl terminate "$udid" com.apple.mobilesafari >/dev/null 2>&1; sleep 2
    if python3 - "$plist" "$extid" <<'PY'
import plistlib, sys, datetime
path, ext = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f: d = plistlib.load(f)
keys = [k for k in d if k.split(' ')[0] == ext]
if not keys: sys.exit(1)
e = d[keys[0]]
until = datetime.datetime(2100, 1, 1)
e['Enabled'] = True
e['GrantedPermissionOrigins'] = {o: until for o in e.get('AccessibleOrigins', [])}
e['GrantedPermissions'] = {p: until for p in e.get('Permissions', [])}
with open(path, 'wb') as f: plistlib.dump(d, f, fmt=plistlib.FMT_BINARY)
print('enabled', keys[0])
PY
    then step enable true "Extensions.plist: Enabled=true and the requested origins and permissions granted (what Settings > Apps > Safari > Extensions would store), Safari restarted"
    else step enable false "Extensions.plist has no entry for $extid"; fi
  else
    step enable false "no Extensions.plist in Safari's container"
  fi
  # The extension's content script on the web player announces itself; the page's status
  # line then says "direct via melodica extension <version>". The real page, over the internet.
  # Since web 0.3 that line can be below the fold on a phone; the page also shows text that
  # only the extension's state produces (melodica-web app.js: the "in the melodica extension,
  # then come back" hint from the bridged gate/login state), so either one counts.
  xcrun simctl openurl "$udid" "https://spacegho.st/melodica/app/" && sleep 20
  xcrun simctl io "$udid" screenshot "$art/smoke-ios-bridge.png" >/dev/null 2>&1
  swiftc -O -o "${TMPDIR:-/tmp}/melodica-ocr" ios/scripts/ocr.swift >/dev/null 2>&1 || true
  ocr() { if [ -x "${TMPDIR:-/tmp}/melodica-ocr" ]; then "${TMPDIR:-/tmp}/melodica-ocr" "$1" 2>/dev/null | tr '\n' ' '; fi; }
  text="$(ocr "$art/smoke-ios-bridge.png")"
  echo "bridge screenshot text: $text"
  if grep -qi "via melodica.extension" <<<"$text"; then
    enabled=true
    step bridge true "https://spacegho.st/melodica/app/ in Safari says \"$(grep -oi 'direct via melodica.extension[^·]*' <<<"$text" | head -1 | sed 's/ *$//')\": the extension's content script ran in Safari; screenshot smoke-ios-bridge.png"
  elif hint="$(grep -oi 'Sign in [^.]* in the melodica extension, then come back' <<<"$text" | head -1)" && [ -n "$hint" ]; then
    enabled=true
    step bridge true "https://spacegho.st/melodica/app/ in Safari shows \"$hint\", text the page renders only from the extension's bridged state: the extension's content script ran in Safari; screenshot smoke-ios-bridge.png"
  else
    step bridge false "the web player did not report the extension; screen text: $(cut -c1-300 <<<"$text")"
  fi
  { echo "== Extensions.plist after =="; [ -n "$plist" ] && plutil -p "$plist"
    echo "== WebExtensions dirs =="; find "$data/Containers/Data/Application" -ipath '*WebExtension*' -maxdepth 8 2>/dev/null | head -40
  } >> "$art/smoke-ios-discovery.txt" 2>&1
  # The extension's own pages need its base URL, safari-web-extension://<unique id>/; Safari
  # does not publish it, so look for a UUID that Safari stored for the extension.
  uid="$(plutil -convert json -o - "$plist" 2>/dev/null | python3 -c '
import json,sys,re
d=json.load(sys.stdin)
for k,v in d.items():
  if k.startswith(sys.argv[1]):
    for kk,vv in v.items():
      if isinstance(vv,str) and re.fullmatch(r"[0-9A-Fa-f-]{36}",vv): print(vv); sys.exit()
' "$extid")"
  if [ -n "$uid" ]; then
    xcrun simctl openurl "$udid" "safari-web-extension://$uid/popup.html" && sleep 12
    xcrun simctl io "$udid" screenshot "$art/smoke-ios-popup.png" >/dev/null 2>&1
    text="$(ocr "$art/smoke-ios-popup.png")"
    echo "popup screenshot text: $text"
    if grep -qi "github\|pandora\|melodica" <<<"$text"; then step popup true "safari-web-extension://$uid/popup.html rendered in a tab: $(cut -c1-200 <<<"$text")"
    else step popup false "popup.html by URL showed: $(cut -c1-200 <<<"$text")"; fi
  else
    step popup false "no base URL for the extension's pages found, so popup.html, the player and the tuner login were not opened (opening the popup needs a tap on Safari's extensions menu, which this run cannot make)"
  fi
  [ "$enabled" = true ] || step extension false "the extension did not show up as running in Safari"
fi

node - "$steps" "$art/smoke-ios.json" "$version" "${TUNER_HTTPS_URL:-}" "${devname:-} ${runtime:-}" <<'JS'
const fs = require('fs');
const [steps, out, version, tuner, device] = process.argv.slice(2);
const list = fs.readFileSync(steps, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const need = ['boot', 'install', 'launch', 'pluginkit'];
const ok = need.every((n) => list.some((s) => s.name === n && s.ok));
const ext = list.find((s) => s.name === 'bridge');
const summary = ok
  ? `app ${version} installed and launched on the ${device.trim().replace(/_/g, ' ')} simulator; pluginkit lists the Safari extension` + (ext && ext.ok ? '; with the extension switched on in Safari, its content script ran on spacegho.st/melodica/app/ (the page reported the extension)' : '; the web player check did not detect the extension in Safari')
  : 'failed: ' + list.filter((s) => !s.ok && s.name !== 'extension').map((s) => s.name + ': ' + s.detail).join('; ');
const r = { ok, platform: 'ios', version, device: device.trim().replace(/_/g, ' '), summary, when: new Date().toISOString(), steps: list.filter((s) => s.ok).map((s) => s.name), checks: list, tuner: tuner || null, extensionEnabled: !!(ext && ext.ok) };
fs.writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify(r, null, 2));
JS
rm -f "$steps"
