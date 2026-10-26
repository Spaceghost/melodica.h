"""Content-addressed, richly described offline audio library."""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

try:
    from mutagen.id3 import (
        APIC,
        COMM,
        ID3,
        ID3NoHeaderError,
        POPM,
        TALB,
        TCON,
        TDRC,
        TIT2,
        TLEN,
        TPE1,
        TPE2,
        TPOS,
        TPUB,
        TRCK,
        TXXX,
    )
except ImportError:
    ID3 = None


_PRIVATE_PARTS = ("url", "token", "password", "auth", "secret", "cookie")
_BAD_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


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
        self.tracks = self.root / "tracks"
        self.objects.mkdir(parents=True, exist_ok=True)
        self.metadata.mkdir(parents=True, exist_ok=True)
        self.tracks.mkdir(parents=True, exist_ok=True)
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

    @staticmethod
    def _component(value, fallback):
        cleaned = _BAD_FILENAME.sub("_", str(value or fallback)).strip(" .")
        return (cleaned or fallback)[:160]

    @staticmethod
    def _ffmpeg_metadata(metadata):
        names = {
            "title": "title",
            "artist": "artist",
            "album": "album",
            "album_artist": "album_artist",
            "genre": "genre",
            "date": "date",
            "track": "track",
            "disc": "disc",
        }
        result = []
        for source, target in names.items():
            value = metadata.get(source)
            if value not in (None, ""):
                result.extend(("-metadata", "{}={}".format(target, value)))
        station = metadata.get("station")
        if station:
            result.extend(("-metadata", "comment=Pandora station: {}".format(station)))
        result.extend(("-metadata", "publisher=Pandora"))
        return result

    def _to_mp3(self, source, destination, metadata):
        ffmpeg = shutil.which("ffmpeg")
        encoding = str(metadata.get("encoding") or "").lower()
        if ffmpeg:
            codec = "copy" if encoding == "mp3" else "libmp3lame"
            command = [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-c:a",
                codec,
            ]
            if codec != "copy":
                command.extend(("-q:a", "2"))
            command.extend(self._ffmpeg_metadata(metadata))
            command.extend(("-id3v2_version", "3", str(destination)))
            subprocess.run(command, check=True)
            return
        if encoding != "mp3":
            raise RuntimeError("ffmpeg is required to convert this stream to MP3")
        shutil.copyfile(source, destination)

    @staticmethod
    def _cover_art(metadata, timeout):
        url = metadata.get("album_art_url") or metadata.get("cover_art_url")
        if not url:
            return None
        request = urllib.request.Request(url, headers={"User-Agent": "melodica-offline/1"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read(10 * 1024 * 1024 + 1)
            if len(data) > 10 * 1024 * 1024:
                raise ValueError("cover art exceeds 10 MiB")
            return response.headers.get_content_type(), data

    @staticmethod
    def _write_id3(path, metadata, artwork=None):
        if ID3 is None:
            return False
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
        tags.delall("TIT2")
        tags.add(TIT2(encoding=3, text=str(metadata.get("title") or "Unknown Title")))
        tags.delall("TPE1")
        tags.add(TPE1(encoding=3, text=str(metadata.get("artist") or "Unknown Artist")))
        tags.delall("TALB")
        tags.add(TALB(encoding=3, text=str(metadata.get("album") or "Unknown Album")))
        optional = (
            ("album_artist", TPE2),
            ("genre", TCON),
            ("date", TDRC),
            ("track", TRCK),
            ("disc", TPOS),
        )
        for key, frame in optional:
            if metadata.get(key) not in (None, ""):
                tags.delall(frame.FrameID)
                tags.add(frame(encoding=3, text=str(metadata[key])))
        tags.delall("TPUB")
        tags.add(TPUB(encoding=3, text="Pandora"))
        if metadata.get("duration"):
            tags.delall("TLEN")
            tags.add(TLEN(encoding=3, text=str(int(float(metadata["duration"]) * 1000))))
        station = metadata.get("station")
        if station:
            tags.delall("COMM:Station:eng")
            tags.add(COMM(encoding=3, lang="eng", desc="Station", text=str(station)))
        custom = {
            "Station ID": metadata.get("station_id"),
            "Music ID": metadata.get("music_id"),
            "Rating": metadata.get("rating"),
            "Track gain": metadata.get("track_gain"),
            "Source encoding": metadata.get("encoding"),
            "Source bitrate": metadata.get("bitrate"),
            "Captured by": metadata.get("client"),
            "Protocol": metadata.get("protocol"),
            "Melodica identity": OfflineLibrary.identity(metadata),
        }
        for description, value in custom.items():
            if value not in (None, ""):
                tags.delall("TXXX:{}".format(description))
                tags.add(TXXX(encoding=3, desc=description, text=str(value)))
        rating = str(metadata.get("rating") or "").lower()
        if rating:
            popm = 255 if rating in ("love", "1", "true") else 0 if rating in ("ban", "-1") else 128
            tags.delall("POPM:melodica@local")
            tags.add(POPM(email="melodica@local", rating=popm, count=0))
        if artwork:
            mime_type, data = artwork
            tags.delall("APIC:")
            tags.add(APIC(encoding=3, mime=mime_type, type=3, desc="Cover", data=data))
        tags.save(path, v2_version=3)
        return True

    def _library_path(self, audio_path, metadata, identity):
        artist = self._component(metadata.get("artist"), "Unknown Artist")
        album = self._component(metadata.get("album"), "Unknown Album")
        title = self._component(metadata.get("title"), "Unknown Title")
        directory = self.tracks / artist / album
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / "{}.mp3".format(title)
        link = directory / ".{}.{}.tmp".format(title, identity[:8])
        link.unlink(missing_ok=True)
        try:
            os.link(audio_path, link)
        except OSError:
            shutil.copy2(audio_path, link)
        link.replace(destination)
        return destination

    def import_file(self, source, metadata, media_type="audio/mpeg", timeout=30):
        """Normalize and tag an already downloaded stream as a library MP3."""
        safe = _public_metadata(metadata)
        captured_at = int(metadata.get("captured_at") or time.time())
        identity = self.identity(safe)
        mp3_path = None
        try:
            handle, name = tempfile.mkstemp(dir=self.objects, prefix=".tag-", suffix=".mp3")
            os.close(handle)
            mp3_path = Path(name)
            self._to_mp3(Path(source), mp3_path, safe)
            artwork = None
            try:
                artwork = self._cover_art(metadata, timeout)
            except Exception:
                artwork = None
            embedded = self._write_id3(mp3_path, safe, artwork)
            digest = hashlib.sha256()
            with mp3_path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 256), b""):
                    digest.update(block)
            sha256 = digest.hexdigest()
            audio_path = self.objects / "{}.mp3".format(sha256)
            if audio_path.exists():
                mp3_path.unlink()
            else:
                mp3_path.replace(audio_path)
            mp3_path = None
            library_path = self._library_path(audio_path, safe, identity)

            record = dict(safe)
            record.update(
                {
                    "schema": "org.melodica.offline.v2",
                    "sha256": sha256,
                    "byte_length": audio_path.stat().st_size,
                    "media_type": "audio/mpeg",
                    "captured_at": captured_at,
                    "audio_file": audio_path.name,
                    "library_file": str(library_path.relative_to(self.root)),
                    "embedded_id3": embedded,
                }
            )
            metadata_path = self.metadata / "{}.json".format(sha256)
            serialized = json.dumps(record, sort_keys=True, ensure_ascii=False)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.metadata,
                prefix=".metadata-", delete=False
            ) as output:
                output.write(json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
                temporary_metadata = Path(output.name)
            temporary_metadata.replace(metadata_path)
            with sqlite3.connect(self.database) as db:
                db.execute(
                    """INSERT OR REPLACE INTO recordings
                    (sha256, audio_path, metadata_path, media_type, byte_length,
                     captured_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        sha256,
                        str(audio_path),
                        str(metadata_path),
                        "audio/mpeg",
                        audio_path.stat().st_size,
                        captured_at,
                        serialized,
                    ),
                )
                db.execute(
                    "INSERT OR REPLACE INTO identities (identity, sha256) VALUES (?, ?)",
                    (identity, sha256),
                )
            return library_path
        finally:
            if mp3_path is not None:
                mp3_path.unlink(missing_ok=True)

    def capture(self, source_url, metadata, timeout=30):
        """Download one authorized stream and commit a fully tagged MP3."""
        request = urllib.request.Request(
            source_url,
            headers={"User-Agent": "melodica-offline/1"},
        )
        tmp_path = None
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                media_type = response.headers.get_content_type()
                with tempfile.NamedTemporaryFile(
                    dir=self.objects, prefix=".capture-", delete=False
                ) as output:
                    tmp_path = Path(output.name)
                    while True:
                        block = response.read(1024 * 256)
                        if not block:
                            break
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
            return self.import_file(tmp_path, metadata, media_type, timeout)
        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
