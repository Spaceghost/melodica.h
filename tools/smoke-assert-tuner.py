#!/usr/bin/env python3
"""Check melodica-tuner's request log against the smoke harness's reports, and record it in them.

  tools/smoke-assert-tuner.py --log-url URL --health-url URL --out tuner-log.json REPORT [REPORT ...]

Each REPORT is a smoke-core.json written by tools/smoke/XivPiano.Smoke. For each, the tuner log must
hold a successful auth.partnerLogin, auth.userLogin, user.getStationList and station.getPlaylist from
that report's user agent (XivPiano/x.y.z smoke/<platform>); those become the "<method> ok" steps
tuner/report.py would add, "tuner" becomes the server's version, and the report is rewritten in place.
The log (request bodies dropped) is written to --out. Exit 1 when any report fails the check; a
report whose own "ok" is false is reported, not rewritten as passing.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

REQUIRED = ("auth.partnerLogin", "auth.userLogin", "user.getStationList", "station.getPlaylist")


def fetch(url: str):
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - the CI test server
        return json.load(response)


def entries(log) -> list[dict]:
    if isinstance(log, dict):
        for key in ("log", "entries", "requests", "items"):
            if isinstance(log.get(key), list):
                return log[key]
        raise SystemExit("tuner log: no list of entries in " + ", ".join(log))
    return list(log)


def field(entry: dict, *names: str):
    lowered = {k.lower().replace("_", "").replace("-", ""): v for k, v in entry.items()}
    for name in names:
        if name in lowered:
            return lowered[name]
    return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log-url", required=True)
    ap.add_argument("--health-url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("reports", nargs="+")
    args = ap.parse_args(argv)

    health = fetch(args.health_url)
    version = str(health.get("version", "unknown"))
    log = entries(fetch(args.log_url))
    kept = [{k: v for k, v in e.items() if k.lower() not in ("body", "decrypted", "decryptedbody", "decrypted_body")} for e in log]
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"tuner": version, "health": health, "log": kept}, f, indent=2)
    print(f"tuner {version}: {len(log)} logged requests")

    failed = 0
    for path in args.reports:
        with open(path, encoding="utf-8") as f:
            report = json.load(f)
        agent = "smoke/" + ("win-x64" if "win-x64" in report.get("platform", "") else "linux-x64")
        mine = [e for e in log if agent in str(field(e, "useragent", "agent", "ua") or "")]
        seen: dict[str, dict] = {}
        for e in mine:
            method = str(field(e, "method") or "")
            code = field(e, "code", "errorcode", "error")
            status = field(e, "status", "httpstatus")
            ok = code in (None, 0, "") and (status is None or int(status) == 200)
            if method in REQUIRED and ok and method not in seen:
                seen[method] = e
        missing = [m for m in REQUIRED if m not in seen]
        steps = list(report.get("steps", []))
        for m in REQUIRED[1:]:
            if m in seen and f"{m} ok" not in steps:
                steps.append(f"{m} ok")
        report["steps"] = steps
        report["tuner"] = version
        report.setdefault("server", {})
        report["server"]["logged_requests"] = len(mine)
        report["server"]["user_agent"] = agent
        if missing or not report.get("ok"):
            failed += 1
            report["ok"] = False
            why = ("the tuner log lacks a successful " + ", ".join(missing)) if missing else "the harness did not pass"
            report["error"] = (report.get("error") + "; " if report.get("error") else "") + why
            print(f"{path}: FAILED, {why} ({len(mine)} requests from {agent})")
            for e in mine:
                print("   ", json.dumps({k: field(e, k) for k in ("method", "status", "code")}))
        else:
            print(f"{path}: ok, {len(mine)} requests from {agent}: " + ", ".join(str(field(e, "method")) for e in mine))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
            f.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
