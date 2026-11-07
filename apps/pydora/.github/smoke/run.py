#!/usr/bin/env python3
"""Drive the released pydora under a pty and record what was observed.

Writes into --out:
  smoke-linux.txt           full transcript (ANSI stripped)
  smoke-linux.json          machine-readable result; "ok" is true only when the
                            whole login -> stations -> playing path was observed
  smoke-linux-login.png     rendering of the start/login part of the transcript
  smoke-linux-stations.png  rendering of the station list / now-playing part
Exit status is 0 when every assertion for the chosen --mode held.
"""
import argparse
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
STATION = re.compile(r"^\s*(\d+): (.+)$", re.M)
NOW_PLAYING = re.compile(r"\x1b\[36m(.+?)\x1b\[0m by \x1b\[33m(.+?)\x1b\[0m")


# Same vocabulary as melodica-tuner's tuner/report.py
LOG_STEPS = [
    ("json", "auth.partnerLogin", "auth.partnerLogin ok"),
    ("json", "auth.userLogin", "auth.userLogin ok"),
    ("json", "user.getStationList", "user.getStationList ok"),
    ("json", "station.getPlaylist", "station.getPlaylist ok"),
    ("audio", None, "audio fetched"),
]
REQUIRED_LOG_STEPS = [t for _, _, t in LOG_STEPS]


def log_steps(entries):
    seen = set()
    for e in entries:
        if e.get("code") is None and int(e.get("status") or 0) < 400:
            seen.add((e.get("protocol"), e.get("method")))
            if e.get("protocol") == "audio":
                seen.add(("audio", None))
    return [t for proto, method, t in LOG_STEPS if (proto, method) in seen]


class Session:
    def __init__(self, argv, env, timeout):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.environ.update(env)
            os.execvp(argv[0], argv)
        self.raw = b""
        self.deadline = time.time() + timeout
        self.status = None

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    self.reap(block=False)
                    return False
                self.raw += chunk
            else:
                if self.reap(block=False) is not None:
                    return False
        return True

    def wait_for(self, pattern, what):
        rx = re.compile(pattern)
        while True:
            if rx.search(self.text()):
                return rx.search(self.text())
            if time.time() > self.deadline:
                raise TimeoutError("timed out waiting for " + what)
            if not self.pump(1):
                if rx.search(self.text()):
                    return rx.search(self.text())
                raise RuntimeError("pydora exited while waiting for " + what)

    def send(self, line):
        os.write(self.fd, line.encode())

    def text(self):
        return self.raw.decode("utf-8", "replace")

    def reap(self, block=True):
        if self.status is None:
            pid, status = os.waitpid(self.pid, 0 if block else os.WNOHANG)
            if pid:
                self.status = status
        return self.status

    def finish(self, grace=10):
        end = time.time() + grace
        while time.time() < end and self.reap(block=False) is None:
            self.pump(0.5)
        if self.reap(block=False) is None:
            os.kill(self.pid, signal.SIGTERM)
            self.pump(2)
            if self.reap(block=False) is None:
                os.kill(self.pid, signal.SIGKILL)
            self.reap(block=True)
        self.pump(0.5)
        return os.waitstatus_to_exitcode(self.status)


def render(text, path, title):
    lines = [line[:120] for line in text.splitlines()]
    if len(lines) > 70:
        lines = lines[:30] + ["", "[... %d lines ...]" % (len(lines) - 55), ""] + lines[-25:]
    body = title + "\n" + "\n".join(lines)
    body = body.replace("\\", "\\\\").replace("%", "%%").replace("@", "\\@")
    cmd = [
        "convert", "-background", "#111418", "-fill", "#d6dde5",
        "-font", "DejaVu-Sans-Mono", "-pointsize", "14",
        "-bordercolor", "#111418", "-border", "16", "label:" + body, path,
    ]
    try:
        subprocess.run(cmd, check=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        print("png rendering failed:", exc, file=sys.stderr)
        return False
    return os.path.exists(path)


def fetch(url, ca):
    import ssl
    ctx = ssl.create_default_context(cafile=ca) if ca else None
    with urllib.request.urlopen(url, timeout=30, context=ctx) as resp:
        return resp.read().decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=("offline", "tuner"), required=True)
    ap.add_argument("--cfg", required=True, help="pydora.cfg to use")
    ap.add_argument("--player-log", required=True, help="PYDORA_SMOKE_PLAYER_LOG")
    ap.add_argument("--log-url", default="", help="tuner request log URL")
    ap.add_argument("--ca", default="", help="CA bundle for the tuner")
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--meta", default="{}", help="extra JSON merged into the report")
    ap.add_argument("--platform", default="linux")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    env = {"PYDORA_CFG": args.cfg, "PYDORA_SMOKE_PLAYER_LOG": args.player_log,
           "TERM": "xterm", "COLUMNS": "120", "LINES": "50"}
    # Shape shared with melodica-tuner's `python3 -m tuner.report` so the
    # melodica minisite can render it; everything under "observed" is extra.
    report = {
        "ok": False,
        "platform": args.platform,
        "summary": "",
        "when": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "steps": [],
        "tuner": None,
        "mode": args.mode,
        "observed": {},
        "errors": [],
    }
    report.update(json.loads(args.meta))
    report["steps"].append("installed")  # the caller only runs us after the install step

    sess = Session(["pydora", "-v"], env, args.timeout)
    code = None
    try:
        m = sess.wait_for(r"Using (mpg123|VLC|Remote VLC)", "player selection")
        report["observed"]["player_line"] = m.group(0)
        report["steps"].append("started")
        if args.mode == "offline":
            code = sess.finish(grace=args.timeout)
            text = sess.text()
            m = re.search(r"(ConnectionError|Max retries exceeded|Connection refused|NewConnectionError)[^\n]*", text)
            if not m:
                raise AssertionError("no connection error in the transcript")
            report["observed"]["connection_error"] = ANSI.sub("", m.group(0)).strip()[:300]
            report["observed"]["login_attempt"] = bool(re.search(r"auth\.partnerLogin", text))
            if code == 0:
                raise AssertionError("pydora exited 0 without a server")
            if "Traceback" in text and not re.search(r"requests\.exceptions\.ConnectionError", text):
                raise AssertionError("pydora crashed with something other than a connection error")
        else:
            sess.wait_for(r"Station: ", "station menu")
            menu = ANSI.sub("", sess.text())
            stations = [(int(n), name.strip()) for n, name in STATION.findall(menu)]
            if not stations:
                raise AssertionError("station menu is empty")
            report["steps"].append("logged in")
            report["observed"]["stations"] = [name for _, name in stations][:20]
            report["steps"].append("stations listed")
            sess.send("%d\n" % stations[0][0])
            m = sess.wait_for(NOW_PLAYING.pattern, "now playing line")
            report["observed"]["now_playing"] = {"song": m.group(1), "artist": m.group(2)}
            # give the player a few seconds to fetch and start decoding
            sess.pump(8)
            sess.send("Q\n")
            code = sess.finish(grace=15)
            player_in = open(args.player_log + ".in").read() if os.path.exists(args.player_log + ".in") else ""
            player_out = open(args.player_log + ".out").read() if os.path.exists(args.player_log + ".out") else ""
            load = re.search(r"load (\S+)", player_in)
            if not load:
                raise AssertionError("mpg123 never received a load command")
            report["observed"]["player_load_url"] = load.group(1)
            report["observed"]["player_commands"] = [l for l in player_in.splitlines() if l][:10]
            report["observed"]["player_replies"] = [l for l in player_out.splitlines() if l][:12]
            report["observed"]["player_decoded"] = bool(re.search(r"^@S ", player_out, re.M))
            report["observed"]["player_playing"] = bool(re.search(r"^@P 2", player_out, re.M))
            report["steps"].append("playing")
            if args.log_url:
                raw = fetch(args.log_url, args.ca or None)
                with open(os.path.join(args.out, "smoke-linux-tuner-log.json"), "w") as f:
                    f.write(raw)
                entries = json.loads(raw)
                try:
                    health = json.loads(fetch(args.log_url.replace("/__tuner/log", "/__tuner/health"), args.ca or None))
                    report["tuner"] = health.get("version")
                except Exception as exc:  # noqa: BLE001
                    report["observed"]["health_error"] = str(exc)
                report["steps"].extend(log_steps(entries))
                audio = [e for e in entries if e.get("protocol") == "audio"]
                report["observed"]["tuner_calls"] = [
                    "%s %s status=%s code=%s ua=%s" % (e.get("protocol"), e.get("method") or e.get("path") or "",
                                                       e.get("status"), e.get("code"), e.get("userAgent"))
                    for e in entries][:40]
                report["observed"]["audio_requests"] = [
                    {k: e.get(k) for k in ("method", "path", "status", "userAgent", "host")} for e in audio][:5]
                missing = [t for t in REQUIRED_LOG_STEPS if t not in report["steps"]]
                if missing:
                    raise AssertionError("tuner log lacks " + ", ".join(missing))
            report["ok"] = True
            report["summary"] = "pydora logged in, listed %d stations and played %s by %s" % (
                len(stations), report["observed"]["now_playing"]["song"], report["observed"]["now_playing"]["artist"])
    except Exception as exc:  # noqa: BLE001
        report["errors"].append("%s: %s" % (type(exc).__name__, exc))
        if code is None:
            code = sess.finish(grace=3)
    if not report["summary"]:
        report["summary"] = ("pydora started and attempted a login without a server (expected)"
                             if args.mode == "offline" and not report["errors"]
                             else "; ".join(report["errors"]) or "pydora smoke test did not complete")
    report["exit_code"] = code
    text = ANSI.sub("", sess.text()).replace("\r\n", "\n").replace("\r", "\n")
    report["transcript"] = "smoke-linux.txt"
    with open(os.path.join(args.out, "smoke-linux.txt"), "w") as f:
        f.write(text)
    cut = text.find("Station: ")
    login_part = text if cut < 0 else text[:cut]
    report["images"] = {}
    if render(login_part, os.path.join(args.out, "smoke-linux-login.png"), "$ pydora -v   (start + login)"):
        report["images"]["login"] = "smoke-linux-login.png"
    if cut >= 0 and render(text[cut - 2000 if cut > 2000 else 0:], os.path.join(args.out, "smoke-linux-stations.png"), "$ pydora -v   (stations + now playing)"):
        report["images"]["stations"] = "smoke-linux-stations.png"
    with open(os.path.join(args.out, "smoke-linux.json"), "w") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    print(json.dumps(report, indent=2, sort_keys=True))
    ok = not report["errors"] and (args.mode == "offline" or report["ok"])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
