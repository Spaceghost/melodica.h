"""Content-addressed, richly described offline audio library."""

import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
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
        USLT,
    )
except ImportError:
    ID3 = None


_PRIVATE_PARTS = ("url", "token", "password", "auth", "secret", "cookie")
_BAD_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_NORMALIZE_TEXT = re.compile(r"[^a-z0-9]+")


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
        self.artwork = self.root / "artwork"
        self.lyrics = self.root / "lyrics"
        self.by_music_id = self.root / "by-music-id"
        self.objects.mkdir(parents=True, exist_ok=True)
        self.metadata.mkdir(parents=True, exist_ok=True)
        self.tracks.mkdir(parents=True, exist_ok=True)
        self.artwork.mkdir(parents=True, exist_ok=True)
        self.lyrics.mkdir(parents=True, exist_ok=True)
        self.by_music_id.mkdir(parents=True, exist_ok=True)
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
            db.execute(
                """CREATE TABLE IF NOT EXISTS lyrics (
                    identity TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    provider_id TEXT,
                    instrumental INTEGER NOT NULL DEFAULT 0,
                    word_synced INTEGER NOT NULL DEFAULT 0,
                    plain_lyrics TEXT,
                    synced_lyrics TEXT,
                    lyrics_file TEXT,
                    fetched_at INTEGER NOT NULL
                )"""
            )
        self.rebuild_index()

    @staticmethod
    def _sha256(path):
        digest = hashlib.sha256()
        with Path(path).open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 256), b""):
                digest.update(block)
        return digest.hexdigest()

    @staticmethod
    def identity(metadata):
        """Return a stable key from descriptive, non-secret track fields."""
        safe = _public_metadata(metadata)
        if safe.get("music_id"):
            fields = {"music_id": str(safe["music_id"]).strip()}
        else:
            fields = {}
            for key in ("artist", "album", "title"):
                value = safe.get(key)
                if value is not None:
                    fields[key] = " ".join(str(value).casefold().split())
            if safe.get("duration") is not None:
                try:
                    fields["duration"] = int(round(float(safe["duration"])))
                except (TypeError, ValueError):
                    pass
        material = json.dumps(fields, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(material).hexdigest()

    @staticmethod
    def _music_id(value):
        value = str(value or "")
        return value if value and re.fullmatch(r"[A-Za-z0-9._-]+", value) else None

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

    def lookup_music_id(self, music_id):
        """Return the stable local alias used by non-Python clients."""
        safe_id = self._music_id(music_id)
        if safe_id:
            path = self.by_music_id / "{}.mp3".format(safe_id)
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
    def _normalized(value):
        return _NORMALIZE_TEXT.sub("", str(value or "").casefold())

    def _fetch_lyrics(self, metadata, timeout):
        required = ("artist", "album", "title", "duration")
        if any(metadata.get(key) in (None, "") for key in required):
            return None
        query = urllib.parse.urlencode(
            {
                "artist_name": metadata["artist"],
                "album_name": metadata["album"],
                "track_name": metadata["title"],
                "duration": int(round(float(metadata["duration"]))),
            }
        )
        request = urllib.request.Request(
            "https://lrclib.net/api/get?" + query,
            headers={"User-Agent": "melodica-offline/2 (https://github.com/Spaceghost/melodica.h)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
            return None
        comparisons = (("trackName", "title"), ("artistName", "artist"), ("albumName", "album"))
        if any(self._normalized(result.get(remote)) != self._normalized(metadata.get(local))
               for remote, local in comparisons):
            return None
        try:
            if abs(float(result.get("duration")) - float(metadata["duration"])) > 2.0:
                return None
        except (TypeError, ValueError):
            return None
        return {
            "provider": "LRCLIB",
            "provider_id": str(result.get("id") or ""),
            "instrumental": bool(result.get("instrumental")),
            "word_synced": bool(result.get("hasWordSync")),
            "plain": result.get("plainLyrics") or "",
            "synced": result.get("syncedLyrics") or "",
            "lyricsfile": result.get("lyricsfile") or "",
            "fetched_at": int(time.time()),
        }

    @staticmethod
    def _write_id3(path, metadata, artwork=None, lyrics=None):
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
        if lyrics and lyrics.get("plain"):
            tags.delall("USLT:Lyrics:eng")
            tags.add(USLT(encoding=3, lang="eng", desc="Lyrics", text=lyrics["plain"]))
        if lyrics and lyrics.get("synced"):
            tags.delall("TXXX:Synced lyrics (LRC)")
            tags.add(TXXX(encoding=3, desc="Synced lyrics (LRC)", text=lyrics["synced"]))
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
        music_id = self._music_id(metadata.get("music_id"))
        if music_id:
            alias = self.by_music_id / "{}.mp3".format(music_id)
            temporary = self.by_music_id / ".{}.tmp".format(music_id)
            temporary.unlink(missing_ok=True)
            try:
                os.link(audio_path, temporary)
            except OSError:
                shutil.copy2(audio_path, temporary)
            temporary.replace(alias)
        return destination

    def _write_sidecars(self, identity, artwork, lyrics):
        result = {}
        if artwork:
            mime_type, data = artwork
            extension = {"image/png": ".png", "image/webp": ".webp"}.get(mime_type, ".jpg")
            path = self.artwork / "{}{}".format(identity, extension)
            path.write_bytes(data)
            result["artwork_file"] = str(path.relative_to(self.root))
        if lyrics:
            stem = self.lyrics / identity
            if lyrics.get("plain"):
                path = stem.with_suffix(".txt")
                path.write_text(lyrics["plain"].rstrip() + "\n", encoding="utf-8")
                result["lyrics_file"] = str(path.relative_to(self.root))
            if lyrics.get("synced"):
                path = stem.with_suffix(".lrc")
                path.write_text(lyrics["synced"].rstrip() + "\n", encoding="utf-8")
                result["synced_lyrics_file"] = str(path.relative_to(self.root))
            if lyrics.get("lyricsfile"):
                path = stem.with_suffix(".lyrics.yml")
                path.write_text(lyrics["lyricsfile"].rstrip() + "\n", encoding="utf-8")
                result["word_synced_lyrics_file"] = str(path.relative_to(self.root))
        return result

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
            lyrics = self._fetch_lyrics(safe, timeout)
            embedded = self._write_id3(mp3_path, safe, artwork, lyrics)
            sha256 = self._sha256(mp3_path)
            audio_path = self.objects / "{}.mp3".format(sha256)
            if audio_path.exists():
                mp3_path.unlink()
            else:
                mp3_path.replace(audio_path)
            mp3_path = None
            library_path = self._library_path(audio_path, safe, identity)
            sidecars = self._write_sidecars(identity, artwork, lyrics)

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
            record.update(sidecars)
            if lyrics:
                record["lyrics"] = {
                    "provider": lyrics["provider"],
                    "provider_id": lyrics["provider_id"],
                    "instrumental": lyrics["instrumental"],
                    "word_synced": lyrics["word_synced"],
                }
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
                if lyrics:
                    db.execute(
                        """INSERT OR REPLACE INTO lyrics
                        (identity, provider, provider_id, instrumental, word_synced,
                         plain_lyrics, synced_lyrics, lyrics_file, fetched_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (identity, lyrics["provider"], lyrics["provider_id"],
                         int(lyrics["instrumental"]), int(lyrics["word_synced"]),
                         lyrics["plain"], lyrics["synced"], lyrics["lyricsfile"],
                         lyrics["fetched_at"]),
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

    def rebuild_index(self):
        """Verify records and reconstruct the local SQLite index and aliases."""
        if not self.metadata.is_dir():
            return 0
        count = 0
        with sqlite3.connect(self.database) as db:
            for metadata_path in sorted(self.metadata.glob("*.json")):
                try:
                    record = json.loads(metadata_path.read_text(encoding="utf-8"))
                    sha256 = record["sha256"]
                    audio_path = self.objects / "{}.mp3".format(sha256)
                    if self._sha256(audio_path) != sha256:
                        continue
                except (OSError, KeyError, ValueError):
                    continue
                identity = self.identity(record)
                library_path = self._library_path(audio_path, record, identity)
                record["library_file"] = str(library_path.relative_to(self.root))
                serialized = json.dumps(record, sort_keys=True, ensure_ascii=False)
                db.execute(
                    """INSERT OR REPLACE INTO recordings
                    (sha256, audio_path, metadata_path, media_type, byte_length,
                     captured_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (sha256, str(audio_path), str(metadata_path),
                     record.get("media_type", "audio/mpeg"), audio_path.stat().st_size,
                     int(record.get("captured_at") or 0), serialized),
                )
                db.execute("INSERT OR REPLACE INTO identities VALUES (?, ?)", (identity, sha256))
                lyrics_info = record.get("lyrics") or {}
                if lyrics_info:
                    def sidecar(key):
                        relative = record.get(key)
                        try:
                            return (self.root / relative).read_text(encoding="utf-8") if relative else ""
                        except OSError:
                            return ""
                    db.execute(
                        """INSERT OR REPLACE INTO lyrics
                        (identity, provider, provider_id, instrumental, word_synced,
                         plain_lyrics, synced_lyrics, lyrics_file, fetched_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (identity, lyrics_info.get("provider", "unknown"),
                         lyrics_info.get("provider_id"), int(lyrics_info.get("instrumental", False)),
                         int(lyrics_info.get("word_synced", False)), sidecar("lyrics_file"),
                         sidecar("synced_lyrics_file"), sidecar("word_synced_lyrics_file"),
                         int(record.get("captured_at") or 0)),
                    )
                count += 1
        return count

    def sync_from(self, peer_root):
        """Merge and verify immutable records from another mounted cache."""
        peer = Path(peer_root).expanduser().resolve()
        imported = 0
        for source_metadata in sorted((peer / "metadata").glob("*.json")):
            try:
                record = json.loads(source_metadata.read_text(encoding="utf-8"))
                sha256 = record["sha256"]
                source_audio = peer / "objects" / "{}.mp3".format(sha256)
                if self._sha256(source_audio) != sha256:
                    continue
            except (OSError, KeyError, ValueError):
                continue
            destination_audio = self.objects / source_audio.name
            destination_metadata = self.metadata / source_metadata.name
            if not destination_audio.exists():
                shutil.copy2(source_audio, destination_audio)
                imported += 1
            if not destination_metadata.exists():
                shutil.copy2(source_metadata, destination_metadata)
            for key in ("artwork_file", "lyrics_file", "synced_lyrics_file", "word_synced_lyrics_file"):
                relative = record.get(key)
                if not relative:
                    continue
                source = peer / relative
                destination = self.root / relative
                if source.is_file() and not destination.exists():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
        self.rebuild_index()
        return imported


class StreamingCacheServer:
    """Loopback-only HTTP tee: play and retain a miss from one request."""

    def __init__(self, library=None):
        self.library = library or OfflineLibrary()
        self.jobs = {}
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_HEAD(self):
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.end_headers()

            def do_GET(self):
                token = urllib.parse.urlsplit(self.path).path.lstrip("/")
                job = owner.jobs.get(token)
                if job is None:
                    self.send_error(404)
                    return
                with job["lock"]:
                    cached = owner.library.lookup(job["metadata"])
                    if cached:
                        self.send_response(200)
                        self.send_header("Content-Type", "audio/mpeg")
                        self.send_header("Content-Length", str(cached.stat().st_size))
                        self.end_headers()
                        with cached.open("rb") as stream:
                            shutil.copyfileobj(stream, self.wfile)
                        return
                    owner._forward(self, job)

            def log_message(self, format, *args):
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True,
                                       name="melodica-stream-cache")
        self.thread.start()

    def url_for(self, source_url, metadata):
        cached = self.library.lookup(metadata)
        if cached:
            return cached.resolve().as_uri()
        token = secrets.token_urlsafe(24)
        self.jobs[token] = {"source_url": source_url, "metadata": dict(metadata),
                            "lock": threading.Lock()}
        return "http://127.0.0.1:{}/{}".format(self.server.server_port, token)

    def _forward(self, handler, job):
        request = urllib.request.Request(job["source_url"], headers={"User-Agent": "melodica-offline/2"})
        temporary = None
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                media_type = response.headers.get_content_type()
                handler.send_response(200)
                handler.send_header("Content-Type", media_type)
                length = response.headers.get("Content-Length")
                if length:
                    handler.send_header("Content-Length", length)
                handler.end_headers()
                with tempfile.NamedTemporaryFile(dir=self.library.objects, prefix=".stream-", delete=False) as output:
                    temporary = Path(output.name)
                    client_open = True
                    while True:
                        block = response.read(1024 * 64)
                        if not block:
                            break
                        output.write(block)
                        if client_open:
                            try:
                                handler.wfile.write(block)
                            except (BrokenPipeError, ConnectionResetError):
                                client_open = False
                    output.flush()
                    os.fsync(output.fileno())
            self.library.import_file(temporary, job["metadata"], media_type)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
