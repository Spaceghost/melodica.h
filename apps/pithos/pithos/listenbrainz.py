"""ListenBrainz-compatible scrobbling: spacegho.st (the default) or any
ListenBrainz API server.

The server URL is the API base without the trailing /1/; the client calls
{base}/1/submit-listens and {base}/1/validate-token with
"Authorization: Token <token>". Tokens for spacegho.st come from
https://spacegho.st/melodica/account/.

A listen counts once the song is longer than 30 seconds and has played for
half its length or four minutes, whichever comes first. Listens that cannot be
sent (network errors, 401, 429, 5xx) wait in a JSON queue file and are retried
oldest first; listens the server refuses (other 4xx) are dropped. Now playing
is never queued. The token never appears in logs, errors or the queue file.

Standard library only; works on Python 3.8 and later.
"""

import json
import logging
import os
import tempfile
import threading
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

SPACEGHOST_URL = "https://spacegho.st/scrobble"
LISTENBRAINZ_URL = "https://api.listenbrainz.org"
PRESETS = (
    ("spacegho.st", SPACEGHOST_URL),
    ("ListenBrainz", LISTENBRAINZ_URL),
)
TOKEN_PAGE = "https://spacegho.st/melodica/account/"

MIN_TRACK_S = 30
MAX_NEEDED_S = 240
QUEUE_MAX = 1000
IMPORT_MAX = 100


def listen_counts(duration_s, played_s):
    """True when a play of this length has played long enough to count."""
    try:
        d = float(duration_s)
        p = float(played_s)
    except (TypeError, ValueError):
        return False
    if d <= MIN_TRACK_S:
        return False
    return p >= min(d / 2, MAX_NEEDED_S)


def normalize_base(url):
    """The API base: blank means spacegho.st; a trailing / or /1 is cut."""
    url = (url or "").strip() or SPACEGHOST_URL
    url = url.rstrip("/")
    if url.endswith("/1"):
        url = url[:-2]
    return url


def track_metadata(
    artist,
    title,
    album=None,
    duration_s=None,
    art_url=None,
    station=None,
    client="melodica",
    client_version=None,
):
    """ListenBrainz track_metadata for a Pandora song."""
    info = {
        "submission_client": client,
        "media_player": client,
        "music_service": "pandora.com",
        "music_service_name": "Pandora",
    }
    if client_version:
        info["submission_client_version"] = str(client_version)
        info["media_player_version"] = str(client_version)
    try:
        d = float(duration_s)
    except (TypeError, ValueError):
        d = 0
    if d > 0:
        info["duration_ms"] = int(round(d * 1000))
    # As Pandora gives it (often http); the server keeps a cached copy.
    if isinstance(art_url, str) and art_url.lower().startswith(
        ("http://", "https://")
    ):
        info["art_url"] = art_url
    if station:
        info["station_name"] = str(station)
    meta = {
        "artist_name": str(artist or ""),
        "track_name": str(title or ""),
        "additional_info": info,
    }
    if album:
        meta["release_name"] = str(album)
    return meta


class SubmitError(Exception):
    """A failed request. retry is True when the listen should be kept."""

    def __init__(self, status, message, retry):
        super().__init__(message)
        self.status = status
        self.retry = retry


class ListenBrainzClient:
    def __init__(
        self,
        base_url,
        token,
        queue_path=None,
        client="melodica",
        client_version=None,
        timeout=15,
        urlopen=None,
    ):
        self.base = normalize_base(base_url)
        self._token = (token or "").strip()
        self.queue_path = queue_path
        self.client = client
        self.client_version = client_version
        self.timeout = timeout
        self._urlopen = urlopen or urllib.request.urlopen
        self._lock = threading.Lock()
        self.last_error = None

    def __repr__(self):
        return "ListenBrainzClient({!r})".format(self.base)

    @property
    def configured(self):
        return bool(self._token)

    def metadata(self, artist, title, **kw):
        kw.setdefault("client", self.client)
        kw.setdefault("client_version", self.client_version)
        return track_metadata(artist, title, **kw)

    # HTTP

    def _request(self, method, path, body=None):
        if not self._token:
            raise SubmitError(0, "No token set.", False)
        data = None
        headers = {
            "Authorization": "Token " + self._token,
            "Accept": "application/json",
            "User-Agent": "{}/{}".format(
                self.client, self.client_version or "0"
            ),
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            self.base + path, data=data, headers=headers, method=method
        )
        try:
            with self._urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as e:
            code = e.code
            retry = code in (401, 403, 408, 429) or code >= 500
            raise SubmitError(
                code, "The server answered HTTP {}.".format(code), retry
            )
        except (urllib.error.URLError, OSError, ValueError) as e:
            reason = getattr(e, "reason", e)
            raise SubmitError(
                0,
                "The server could not be reached ({}).".format(
                    type(reason).__name__
                ),
                True,
            )
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return {}

    def validate(self):
        """(valid, user_name) for the token."""
        r = self._request("GET", "/1/validate-token")
        return bool(r.get("valid")), r.get("user_name")

    def _submit(self, listen_type, payload):
        self._request(
            "POST",
            "/1/submit-listens",
            {"listen_type": listen_type, "payload": payload},
        )

    # Submissions

    def now_playing(self, meta):
        """Send now playing; True on success. Errors are logged, not kept."""
        try:
            self._submit("playing_now", [{"track_metadata": meta}])
            return True
        except SubmitError as e:
            self.last_error = str(e)
            log.warning("ListenBrainz now playing failed: %s", e)
            return False

    def listen(self, meta, listened_at):
        """Submit one listen: 'sent', 'queued' or 'dropped'."""
        entry = {"listened_at": int(listened_at), "track_metadata": meta}
        try:
            self._submit("single", [entry])
        except SubmitError as e:
            self.last_error = str(e)
            if e.retry:
                self._enqueue([entry])
                log.warning("ListenBrainz listen queued: %s", e)
                return "queued"
            log.warning("ListenBrainz listen dropped: %s", e)
            return "dropped"
        self.last_error = None
        self.flush()
        return "sent"

    # Queue

    def _load(self):
        if not self.queue_path:
            return getattr(self, "_memory_queue", [])
        try:
            with open(self.queue_path, "r", encoding="utf-8") as f:
                q = json.load(f)
            return q if isinstance(q, list) else []
        except (OSError, ValueError):
            return []

    def _save(self, q):
        if not self.queue_path:
            self._memory_queue = q
            return
        folder = os.path.dirname(os.path.abspath(self.queue_path))
        os.makedirs(folder, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=folder, prefix=".lb-queue-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(q, f)
            os.replace(tmp, self.queue_path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _enqueue(self, entries):
        with self._lock:
            q = self._load() + entries
            self._save(q[-QUEUE_MAX:])

    def pending(self):
        with self._lock:
            return len(self._load())

    def flush(self):
        """Send queued listens oldest first; returns how many were sent."""
        sent = 0
        with self._lock:
            q = self._load()
            while q:
                batch = q[:IMPORT_MAX]
                n = len(batch)
                try:
                    if len(batch) == 1:
                        self._submit("single", batch)
                    else:
                        self._submit("import", batch)
                    sent += len(batch)
                    q = q[n:]
                except SubmitError as e:
                    self.last_error = str(e)
                    if e.retry:
                        break
                    if len(batch) == 1:
                        log.warning("ListenBrainz queued listen dropped: %s", e)
                        q = q[1:]
                    else:
                        # One bad listen refuses an import: go one by one.
                        kept = []
                        for entry in batch:
                            try:
                                self._submit("single", [entry])
                                sent += 1
                            except SubmitError as e1:
                                if e1.retry:
                                    kept.append(entry)
                        q = kept + q[n:]
                        if kept:
                            break
                self._save(q)
            self._save(q)
        if sent:
            log.info("ListenBrainz: sent %d queued listen(s)", sent)
        return sent


class PlayTracker:
    """One play of one song: counts forward play time, says once when due."""

    def __init__(self, duration_s):
        self.duration_s = duration_s
        self.played_s = 0.0
        self.reported = False

    def add(self, seconds):
        if seconds > 0:
            self.played_s += seconds

    def due(self):
        if self.reported or not listen_counts(self.duration_s, self.played_s):
            return False
        self.reported = True
        return True
