#!/usr/bin/env python3
"""Release smoke test for the Linux pianobar tarball.

Unpacks the exact tarball that gets released, checks its shared libraries,
runs pianobar under a pseudo-terminal with a generated config and records the
terminal transcript.  Without a tuner it only proves the binary starts and
attempts a login; with --rpc-host (melodica-tuner) it proves login, station
listing and playback (decoded PCM written to audio_pipe, libao null driver).

Outputs in --out: smoke-linux.txt, smoke-linux.json, smoke-linux-login.png,
smoke-linux-stations.png (tuner mode), smoke-linux-tuner-log.json (tuner mode).
Exit status is non-zero when an expected milestone is missing.
"""
import argparse
import datetime
import glob
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tarfile
import termios
import time
import urllib.request

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def log(msg):
    print("smoke: " + msg, flush=True)


def normalize(raw):
    text = ANSI.sub("", raw.decode("utf-8", "replace")).replace("\r\n", "\n")
    out = []
    for line in text.split("\n"):
        if "\r" in line:
            parts = [p for p in line.split("\r") if p != ""]
            line = parts[-1] if parts else ""
        out.append(line.rstrip())
    return "\n".join(out).rstrip("\n") + "\n"


def render(text, path):
    if shutil.which("convert") is None:
        log("convert not found, skipping " + path)
        return False
    label = text.replace("\\", "\\\\").replace("%", "%%")
    cmd = ["convert", "-background", "#0b0e14", "-fill", "#d7dae0",
           "-font", FONT if os.path.exists(FONT) else "DejaVu-Sans-Mono",
           "-pointsize", "14", "-depth", "8", "-bordercolor", "#0b0e14", "-border", "18",
           "label:" + label, path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log("convert failed: " + r.stderr.strip())
        return False
    return True


def fetch(url, ca):
    import ssl
    ctx = None
    if url.startswith("https"):
        ctx = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    with urllib.request.urlopen(url, timeout=20, context=ctx) as r:
        return r.read().decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tarball", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--user", default="smoke@example.invalid")
    ap.add_argument("--password", default="smoke")
    ap.add_argument("--rpc-host", default=None)
    ap.add_argument("--rpc-tls-port", default="8443")
    ap.add_argument("--ca-bundle", default=None)
    ap.add_argument("--tuner-version", default="none")
    ap.add_argument("--tuner-log-url", default=None)
    ap.add_argument("--tuner-health-url", default=None)
    ap.add_argument("--timeout", type=int, default=120)
    args = ap.parse_args()

    tuner = args.rpc_host is not None
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    when = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    steps = []
    failures = []
    result = {"ok": False, "platform": "linux", "summary": "", "when": when,
              "steps": steps, "tuner": args.tuner_version}

    def finish():
        # ok only when login, stations and playback were proven against a test server
        result["ok"] = bool(tuner) and not failures and "playing" in steps
        if failures:
            result["summary"] = "FAILED: " + "; ".join(failures)
        elif tuner:
            result["summary"] = ("Released Linux tarball installed, started, logged in "
                                 "against melodica-tuner, listed stations and started playback "
                                 "(decoded PCM written to audio_pipe, no sound card)")
        else:
            result["summary"] = ("Released Linux tarball installed and started; pianobar reached "
                                 "its login step without a test server, so login/playback were not proven")
        with open(os.path.join(out, "smoke-linux.json"), "w") as f:
            json.dump(result, f, indent=2)
            f.write("\n")
        log(json.dumps(result))
        return 0 if result["ok"] or (not tuner and not failures) else 1

    # 1. install
    prefix = os.path.join(out, "prefix")
    shutil.rmtree(prefix, ignore_errors=True)
    os.makedirs(prefix)
    with tarfile.open(args.tarball) as tf:
        tf.extractall(prefix)
    bins = glob.glob(os.path.join(prefix, "*", "pianobar"))
    if len(bins) != 1:
        failures.append("tarball does not contain exactly one pianobar binary")
        return finish()
    binary = bins[0]
    os.chmod(binary, 0o755)
    ldd = subprocess.run(["ldd", binary], capture_output=True, text=True).stdout
    missing = [l.strip() for l in ldd.splitlines() if "not found" in l]
    result["ldd"] = {"resolved": len([l for l in ldd.splitlines() if "=>" in l]) - len(missing),
                     "missing": missing}
    if missing:
        failures.append("missing shared libraries: " + ", ".join(missing))
        return finish()
    result["tarball"] = os.path.basename(args.tarball)
    with open(args.tarball, "rb") as f:
        import hashlib
        result["sha256"] = hashlib.sha256(f.read()).hexdigest()
    steps.append("installed")
    log("installed " + binary)

    # 2. config
    home = os.path.join(out, "home")
    shutil.rmtree(home, ignore_errors=True)
    cfgdir = os.path.join(home, ".config", "pianobar")
    os.makedirs(cfgdir)
    # pianobar's audio_pipe must be a FIFO; a reader thread drains it and counts the PCM bytes
    audio_raw = os.path.join(out, "audio.fifo")
    if os.path.exists(audio_raw):
        os.unlink(audio_raw)
    os.mkfifo(audio_raw)
    pcm = {"bytes": 0}

    def drain():
        import threading  # noqa: F401
        rfd = os.open(audio_raw, os.O_RDONLY | os.O_NONBLOCK)
        while True:
            r, _, _ = select.select([rfd], [], [], 0.5)
            if not r:
                if drain_stop[0]:
                    break
                continue
            try:
                chunk = os.read(rfd, 1 << 16)
            except BlockingIOError:
                continue
            except OSError:
                break
            if chunk:
                pcm["bytes"] += len(chunk)
            elif drain_stop[0]:
                break
            else:
                time.sleep(0.05)
    import threading
    drain_stop = [False]
    drainer = threading.Thread(target=drain, daemon=True)
    drainer.start()
    cfg = ["user = " + args.user, "password = " + args.password,
           "audio_quality = low", "audio_pipe = " + audio_raw]
    if tuner:
        cfg += ["rpc_host = " + args.rpc_host, "rpc_tls_port = " + args.rpc_tls_port]
        if args.ca_bundle:
            cfg.append("ca_bundle = " + os.path.abspath(args.ca_bundle))
    else:
        # nothing listens here: proves the login attempt without touching Pandora
        cfg += ["rpc_host = 127.0.0.1", "rpc_tls_port = 1"]
    with open(os.path.join(cfgdir, "config"), "w") as f:
        f.write("\n".join(cfg) + "\n")
    with open(os.path.join(home, ".libao"), "w") as f:
        f.write("default_driver=null\n")
    result["config"] = [l for l in cfg if not l.startswith("password")]

    if args.tuner_health_url:
        try:
            health = fetch(args.tuner_health_url, args.ca_bundle)[:2000]
            result["tuner_health"] = health
            try:
                hv = json.loads(health).get("version")
                if hv and args.tuner_version == "none":
                    result["tuner"] = str(hv)
            except ValueError:
                pass
        except Exception as e:  # noqa: BLE001
            failures.append("tuner health check failed: %s" % e)
            return finish()

    # 3. run under a pty
    env = {"HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"),
           "TERM": "xterm-256color", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "COLUMNS": "110", "LINES": "50"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home)
        os.execve(binary, [binary], env)
    try:
        termios.tcsetattr(fd, termios.TCSANOW, termios.tcgetattr(fd))
        import fcntl
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 110, 0, 0))
    except OSError:
        pass

    raw = b""
    seen = set()
    snapshots = {}
    station_sent = False
    quit_sent_at = None
    play_seen_at = None
    exited = None
    deadline = time.monotonic() + args.timeout

    def mark(name, snap=None):
        if name not in seen:
            seen.add(name)
            steps.append(name)
            log("observed: " + name)
            if snap:
                snapshots[snap] = normalize(raw)

    while True:
        if exited is None:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                exited = status
        r, _, _ = select.select([fd], [], [], 0.25)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                raw += chunk
            elif exited is not None:
                break
        text = normalize(raw)
        if "Welcome to pianobar" in text:
            mark("started")
        if "(i) Login... " in text:
            if tuner:
                mark("login prompt")
            else:
                # done once the login attempt resolved (error line) or pianobar exited
                if re.search(r"\(i\) Login\.\.\. .*(Error|error|Ok\.)", text) or exited is not None:
                    mark("login prompt", "login")
        if tuner:
            if re.search(r"\(i\) Login\.\.\. Ok\.", text):
                mark("logged in", "login")
            if re.search(r"\(i\) Login\.\.\. .*(Error|error)", text) and "logged in" not in seen:
                failures.append("login failed")
                break
            # pianobar prints "\t%2i) %c%c%c %s": index, three flag characters, name
            stations = re.findall(r"^\s*(\d+)\) .{3} (.+)$", text, re.M)
            if "(i) Get stations... Ok." in text and stations:
                mark("stations listed")
                result["stations"] = [s[1].strip() for s in stations][:20]
            if "Select station:" in text and stations and not station_sent:
                os.write(fd, (stations[0][0] + "\n").encode())
                station_sent = True
                log("selected station %s) %s" % (stations[0][0], stations[0][1].strip()))
            m = re.search(r'^\|>\s+"(.*)" by "(.*)" on "(.*)"', text, re.M)
            if m and "stations listed" in seen:
                if play_seen_at is None:
                    play_seen_at = time.monotonic()
                    result["song"] = {"title": m.group(1), "artist": m.group(2), "album": m.group(3)}
                size = pcm["bytes"]
                if size > 0 and "playing" not in seen:
                    result["audio_pipe_bytes"] = size
                    mark("playing", "stations")
                if ("playing" in seen or time.monotonic() - play_seen_at > 15) and quit_sent_at is None:
                    if "playing" not in seen:
                        failures.append("song line appeared but audio_pipe stayed empty")
                        snapshots["stations"] = text
                    # let a bit more PCM through so the byte count is meaningful
                    if time.monotonic() - play_seen_at > 3:
                        os.write(fd, b"q")
                        quit_sent_at = time.monotonic()
            if re.search(r"/!\\ .*|Network error: ", text) and "playing" not in seen:
                err = re.search(r"((?:Network error|Error): .*)", text)
                if err and "logged in" in seen and "stations listed" in seen and play_seen_at is None:
                    failures.append("playback error: " + err.group(1))
                    break
        else:
            if "login prompt" in seen and (exited is not None or "Login prompt" in text):
                break
            if "login prompt" in seen:
                break
        if exited is not None and not r:
            break
        if quit_sent_at and time.monotonic() - quit_sent_at > 10:
            break
        if time.monotonic() > deadline:
            failures.append("timeout after %ss" % args.timeout)
            break

    if exited is None:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(1)
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    try:
        while True:
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                break
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            raw += chunk
    except OSError:
        pass
    os.close(fd)

    transcript = normalize(raw)
    with open(os.path.join(out, "smoke-linux.txt"), "w") as f:
        f.write(transcript)
    print("---- transcript ----\n" + transcript + "---- end ----", flush=True)

    for want in (["started", "login prompt"] if not tuner else
                 ["started", "login prompt", "logged in", "stations listed", "playing"]):
        if want not in seen:
            failures.append("did not observe: " + want)
    drain_stop[0] = True
    drainer.join(2)
    result["audio_pipe_bytes"] = pcm["bytes"]

    render(snapshots.get("login", transcript), os.path.join(out, "smoke-linux-login.png"))
    if tuner:
        render(snapshots.get("stations", transcript), os.path.join(out, "smoke-linux-stations.png"))

    if tuner and args.tuner_log_url:
        try:
            body = fetch(args.tuner_log_url, args.ca_bundle)
            with open(os.path.join(out, "smoke-linux-tuner-log.json"), "w") as f:
                try:
                    json.dump(json.loads(body), f, indent=2)
                except ValueError:
                    f.write(body)
            result["tuner_log"] = {}
            compact = re.sub(r"\s+", "", body)
            for needle in ("auth.partnerLogin", "auth.userLogin", "user.getStationList",
                           "station.getPlaylist"):
                result["tuner_log"][needle] = needle in body
                if not result["tuner_log"][needle]:
                    failures.append("tuner log lacks " + needle)
            audio = "/audio/" in body or '"protocol":"audio"' in compact
            result["tuner_log"]["audio"] = audio
            if not audio:
                failures.append("tuner log shows no audio fetch")
            errs = re.findall(r'"method":"([^"]+)","[^}]*?"code":(\d+)', compact)
            if errs:
                result["tuner_log"]["errors"] = errs
                failures.append("tuner answered error codes: " + ", ".join("%s=%s" % e for e in errs))
        except Exception as e:  # noqa: BLE001
            failures.append("tuner log fetch failed: %s" % e)
    return finish()


if __name__ == "__main__":
    sys.exit(main())
