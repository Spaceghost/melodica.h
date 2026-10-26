"""Content-addressed, richly described offline audio library."""

import hashlib
import json
import mimetypes
import os
import sqlite3
import tempfile
import time
import urllib.request
from pathlib import Path


_PRIVATE_PARTS = ("url", "token", "password", "auth", "secret", "cookie")


def _public_metadata(metadata):
    return {
        str(key): value
        for key, value in metadata.items()
        if value is not None
        and not any(part in str(key).lower() for part in _PRIVATE_PARTS)
    }


class OfflineLibrary:
    """Store complete streams by digest with JSON and SQLite metadata.

    Audio is committed only after the source reaches EOF. Partial downloads are
    discarded. Expiring URLs and authentication material are never persisted.
    """

    def __init__(self, root=None):
        configured = os.environ.get("MELODICA_OFFLINE_DIR")
        self.root = Path(root or configured or Path.home() / ".local/share/melodica/offline")
        self.objects = self.root / "objects"
        self.metadata = self.root / "metadata"
        self.objects.mkdir(parents=True, exist_ok=True)
        self.metadata.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "library.sqlite3"
        self._initialize()

    def _initialize(self):
        with sqlite3.connect(self.database) as db:
            db.execute(
                """CREATE TABLE IF NOT EXISTS recordings (
                    sha256 TEXT PRIMARY KEY,
                    audio_path TEXT NOT NULL,
                    metadata_path TEXT NOT NULL,
                    media_type TEXT,
                    byte_length INTEGER NOT NULL,
                    captured_at INTEGER NOT NULL,
                    metadata_json TEXT NOT NULL
                )"""
            )
            db.execute(
                """CREATE TABLE IF NOT EXISTS identities (
                    identity TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL
                )"""
            )

    @staticmethod
    def identity(metadata):
        """Return a stable key from descriptive, non-secret track fields."""
        safe = _public_metadata(metadata)
        fields = {
            key: safe.get(key)
            for key in ("artist", "album", "title", "duration", "station_id")
            if safe.get(key) is not None
        }
        material = json.dumps(fields, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(material).hexdigest()

    def lookup(self, metadata):
        """Return a complete cached audio object for a track, if one exists."""
        identity = self.identity(metadata)
        with sqlite3.connect(self.database) as db:
            row = db.execute(
                """SELECT recordings.audio_path FROM identities
                JOIN recordings USING (sha256) WHERE identity = ?""",
                (identity,),
            ).fetchone()
        if row:
            path = Path(row[0])
            if path.is_file():
                return path
        return None

    def capture(self, source_url, metadata, timeout=30):
        """Download one authorized stream and atomically add it to the library."""
        safe = _public_metadata(metadata)
        request = urllib.request.Request(
            source_url,
            headers={"User-Agent": "melodica-offline/1"},
        )
        digest = hashlib.sha256()
        tmp_path = None
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                media_type = response.headers.get_content_type()
                suffix = mimetypes.guess_extension(media_type) or ".audio"
                with tempfile.NamedTemporaryFile(
                    dir=self.objects, prefix=".capture-", delete=False
                ) as output:
                    tmp_path = Path(output.name)
                    while True:
                        block = response.read(1024 * 256)
                        if not block:
                            break
                        digest.update(block)
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())

            sha256 = digest.hexdigest()
            audio_path = self.objects / "{}{}".format(sha256, suffix)
            if audio_path.exists():
                tmp_path.unlink()
            else:
                tmp_path.replace(audio_path)
            tmp_path = None

            captured_at = int(time.time())
            record = dict(safe)
            record.update(
                {
                    "schema": "org.melodica.offline.v1",
                    "sha256": sha256,
                    "byte_length": audio_path.stat().st_size,
                    "media_type": media_type,
                    "captured_at": captured_at,
                    "audio_file": audio_path.name,
                }
            )
            metadata_path = self.metadata / "{}.json".format(sha256)
            metadata_path.write_text(
                json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            serialized = json.dumps(record, sort_keys=True, ensure_ascii=False)
            with sqlite3.connect(self.database) as db:
                db.execute(
                    """INSERT OR REPLACE INTO recordings
                    (sha256, audio_path, metadata_path, media_type, byte_length,
                     captured_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        sha256,
                        str(audio_path),
                        str(metadata_path),
                        media_type,
                        audio_path.stat().st_size,
                        captured_at,
                        serialized,
                    ),
                )
                db.execute(
                    "INSERT OR REPLACE INTO identities (identity, sha256) VALUES (?, ?)",
                    (self.identity(safe), sha256),
                )
            return audio_path
        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
