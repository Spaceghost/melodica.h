"""listen:// links: parse and build.

A port of melodica-scrobble src/listen-uri.js (docs/LISTEN-URI.md). It accepts
and rejects exactly what the reference test (tests/listen-uri.test.mjs) does.

    listen://artist/<name>            listen://genre/<name>
    listen://station/<id or token>    listen://track/<id>?t=<seconds>
    listen://map/<land>[/<province>]  listen://user/<username>
    listen://listens                  listen://leaderboard

Also accepted with the same paths: web+listen://... and
https://spacegho.st/listen/... (the form share buttons copy). A link never
starts playback by itself.
"""

import re
import unicodedata
from urllib.parse import quote

HTTPS_BASE = "https://spacegho.st/listen/"
SITE = "https://spacegho.st"
MAX_TEXT = 200
MAX_LINK = 1024
_SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?")
_USERNAME = re.compile(r"[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]")
_STATION = re.compile(r"[A-Za-z0-9]{1,64}")
_TRACK = re.compile(r"(?:[0-9a-f]{64}|[A-Za-z0-9]{1,64})")
_RAW_SEG = re.compile(r"[A-Za-z0-9\-._~%!$&'()*+,;=:@]*")
_SCHEME = re.compile(r"(listen|web\+listen)://([^\n\r  ]*)", re.I)
_SECONDS = re.compile(r"[0-9]{1,5}")
_BAD_CHARS = re.compile(r"[\u0000-\u001f\u007f/\\]")
# JavaScript's String.prototype.trim() set: WhiteSpace and LineTerminator.
_JS_SPACE = "\t\n\u000b\u000c\r         " "         　﻿"

TARGETS = {
    "artist": (("text",), ()),
    "genre": (("text",), ()),
    "station": (("station",), ()),
    "track": (("track",), ("t",)),
    "map": (("slug", "slug?"), ()),
    "user": (("username",), ()),
    "listens": ((), ()),
    "leaderboard": ((), ()),
}
FIELD = {
    "artist": ("name",),
    "genre": ("name",),
    "station": ("station",),
    "track": ("track",),
    "map": ("land", "province"),
    "user": ("username",),
    "listens": (),
    "leaderboard": (),
}


def _js_len(s):
    """Length in UTF-16 code units, as JavaScript counts it."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _decode_component(raw):
    """decodeURIComponent: None where JavaScript would throw."""
    out = bytearray()
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "%":
            h = raw[i + 1 : i + 3]  # noqa: E203
            if len(h) != 2 or not all(
                x in "0123456789abcdefABCDEF" for x in h
            ):
                return None
            out.append(int(h, 16))
            i += 3
        else:
            out.extend(c.encode("utf-8"))
            i += 1
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _decode_seg(raw):
    if not _RAW_SEG.fullmatch(raw):
        return None
    s = _decode_component(raw)
    if s is None or not s or _js_len(s) > MAX_TEXT:
        return None
    if _BAD_CHARS.search(s) or s != s.strip(_JS_SPACE):
        return None
    if s in (".", ".."):
        return None
    return unicodedata.normalize("NFC", s)


def _check_seg(rule, v):
    rule = rule.replace("?", "")
    if rule == "text":
        return v
    pattern = {
        "slug": _SLUG,
        "username": _USERNAME,
        "station": _STATION,
        "track": _TRACK,
    }.get(rule)
    return v if pattern is not None and pattern.fullmatch(v) else None


def _encode(v):
    """encodeURIComponent."""
    return quote(v, safe="-_.!~*'()")


def _forms(o):
    segs = [_encode(o[f]) for f in FIELD[o["target"]] if o.get(f) is not None]
    path = "/".join([o["target"]] + segs)
    if o.get("t") is not None:
        path += "?t={}".format(o["t"])
    return {
        "uri": "listen://" + path,
        "web": "web+listen://" + path,
        "https": HTTPS_BASE + path,
    }


def parse_listen_uri(link):
    """{target, fields..., uri, web, https}, or None when not allowed."""
    if not isinstance(link, str) or _js_len(link) > MAX_LINK:
        return None
    m = _SCHEME.fullmatch(link)
    if m:
        rest = m.group(2)
    elif link.lower().startswith(HTTPS_BASE):
        rest = link[len(HTTPS_BASE) :]  # noqa: E203
    else:
        return None
    if "#" in rest:
        return None
    q = rest.find("?")
    path = rest[:q] if q >= 0 else rest
    query = rest[q + 1 :] if q >= 0 else ""  # noqa: E203
    if path.endswith("/"):
        path = path[:-1]
    parts = path.split("/")
    target = parts.pop(0).lower()
    spec = TARGETS.get(target)
    if spec is None:
        return None
    segs, keys = spec
    required = len([r for r in segs if not r.endswith("?")])
    if len(parts) < required or len(parts) > len(segs):
        return None
    out = {"target": target}
    for i, raw in enumerate(parts):
        v = _decode_seg(raw)
        ok = None if v is None else _check_seg(segs[i], v)
        if ok is None:
            return None
        out[FIELD[target][i]] = ok
    if query:
        for pair in query.split("&"):
            kv = pair.split("=")
            k = kv[0]
            v = kv[1] if len(kv) > 1 else ""
            if k not in keys or k in out:
                return None
            if k == "t":
                if not _SECONDS.fullmatch(v) or int(v) > 86400:
                    return None
                out["t"] = int(v)
    out.update(_forms(out))
    return out


def listen_uri(o):
    """The three forms of {target, fields...}; None if it would not parse."""
    if not isinstance(o, dict) or o.get("target") not in TARGETS:
        return None
    try:
        f = _forms(o)
    except (TypeError, UnicodeEncodeError):
        return None
    return f if parse_listen_uri(f["uri"]) else None


def route_of(p):
    """Where spacegho.st sends each target (a path on SITE)."""
    t = p["target"]
    if t in ("artist", "genre"):
        return "/melodica/app/?seed={}:{}".format(t, _encode(p["name"]))
    if t == "station":
        return "/melodica/app/?station={}".format(_encode(p["station"]))
    if t == "track":
        r = "/melodica/listens/?track={}".format(_encode(p["track"]))
        return r + ("&t={}".format(p["t"]) if p.get("t") is not None else "")
    if t == "map":
        r = "/melodica/map/?land={}".format(_encode(p["land"]))
        if p.get("province"):
            r += "&province={}".format(_encode(p["province"]))
        return r
    if t == "user":
        return "/melodica/leaderboard/?user={}".format(_encode(p["username"]))
    if t == "listens":
        return "/melodica/listens/"
    if t == "leaderboard":
        return "/melodica/leaderboard/"
    return "/melodica/"


def web_url(p):
    """The page to open in a browser for a parsed link."""
    return SITE + route_of(p)
