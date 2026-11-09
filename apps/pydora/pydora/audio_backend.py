import os
import time
import fcntl
import select
import socket
import logging
from shutil import which

from .utils import iterate_forever, SilentPopen
from pandora.melodica_backend import OfflineLibrary, StreamingCacheServer
from .listenbrainz import PlayTracker


log = logging.getLogger("pydora.audio_backend")


class PlayerException(Exception):
    """Base class for all player exceptions"""

    pass


class UnsupportedEncoding(PlayerException):
    """Song encoding is not supported by player backend"""

    pass


class PlayerUnusable(PlayerException):
    """Player can not be used on this system"""

    pass


class BasePlayer:
    """Audio Backend Process Manager

    Starts and owns a handle to an audio backend process then feeds commands to
    it to play pandora audio. This class provides all the base functionality
    for managing the process and feeding it input but should be subclassed to
    fill in the rest of the interface that is specific to a backend.

    Consumers should call start before using the class to pre-start the command
    and decrease response latency when the first play command is sent.
    """

    def __init__(self, callbacks, control_channel):
        """Constructor

        Will attempt to find the player binary on construction and fail if it
        is not found. Subclasses should append any additional arguments to
        _cmd.
        """
        self._control_channel = control_channel
        self._control_fd = control_channel.fileno()
        self._callbacks = callbacks
        self._process = None
        self._cmd = [self._find_path()]
        self._offline_library = OfflineLibrary()
        self._offline_streams = StreamingCacheServer(self._offline_library)
        self._history_metadata = None
        self._paused = False
        self._replaying = False

    def _offline_metadata(self, song):
        return {
            "artist": getattr(song, "artist_name", None),
            "album": getattr(song, "album_name", None),
            "title": getattr(song, "song_name", None),
            "duration": getattr(song, "track_length", None),
            "music_id": getattr(song, "music_id", None),
            "station_id": getattr(song, "station_id", None),
            "rating": getattr(song, "song_rating", None),
            "bitrate": getattr(song, "bitrate", None),
            "encoding": getattr(song, "encoding", None),
            "track_gain": getattr(song, "track_gain", None),
            "album_art_url": getattr(song, "album_art_url", None),
            "song_detail_url": getattr(song, "song_detail_url", None),
            "client": "pydora",
            "protocol": "melodica.h",
        }

    def _playback_url(self, song, use_cached=True):
        metadata = self._offline_metadata(song)
        cached = self._offline_library.lookup(metadata) if use_cached else None
        if cached:
            return cached.resolve().as_uri()
        if use_cached:
            return self._offline_streams.url_for(song.audio_url, metadata)
        return song.audio_url

    def library(self):
        return self._offline_library.list_tracks()

    def play_previous(self, song):
        previous = self._offline_library.previous_track(
            self._offline_metadata(song)
        )
        if not previous:
            return False
        self._history_metadata = previous
        self._replaying = True
        self._load_url(previous["local_uri"])
        return True

    def _find_path(self):
        """Find the path to the backend binary

        This method may fail with a PlayerUnusable exception in which case the
        consumer should opt for another backend.
        """
        raise NotImplementedError

    def _load_track(self, song):
        """Load a track into the audio backend by song model"""
        raise NotImplementedError

    def _player_stopped(self, value):
        """Determine if player has stopped"""
        raise NotImplementedError

    def raise_volume(self):
        """Raise the volume of the audio output

        The player backend may not support this functionality in which case it
        should not override this method.
        """
        raise NotImplementedError

    def lower_volume(self):
        """Lower the volume of the audio output

        The player backend may not support this functionality in which case it
        should not override this method.
        """
        raise NotImplementedError

    def _post_start(self):
        """Optionally, do something after the audio backend is started"""
        return

    def _loop_hook(self):
        """Optionally, do something each main loop iteration"""
        return

    def _read_from_process(self, handle):
        """Read a line from the process and clean it

        Different audio backends return text in different formats so provides a
        hook for each subclass to customize reader behaviour.
        """
        return handle.readline().strip()

    def _send_cmd(self, cmd):
        """Write command to remote process"""
        self._process.stdin.write("{}\n".format(cmd).encode("utf-8"))
        self._process.stdin.flush()

    def stop(self):
        """Stop the currently playing song"""
        self._send_cmd("stop")

    def pause(self):
        """Pause the player"""
        self._paused = not self._paused
        self._send_cmd("pause")

    def __del__(self):
        if self._process:
            self._process.kill()

    def start(self):
        """Start the audio backend process for the player

        This is just a friendlier API for consumers
        """
        self._ensure_started()

    def _ensure_started(self):
        """Ensure player backing process is started"""
        if self._process and self._process.poll() is None:
            return

        if not getattr(self, "_cmd"):
            raise RuntimeError("Player command is not configured")

        log.debug("Starting playback command: %r", self._cmd)
        self._process = SilentPopen(self._cmd)
        self._post_start()

    def _get_select_readers(self):
        """Return a list of file-like objects for reading

        Will be passed to select() to poll for readers.
        """
        return [self._control_channel, self._process.stdout]

    def play(self, song):
        """Play a new song from a Pandora model

        Returns once the stream starts but does not shut down the remote audio
        output backend process. Calls the input callback when the user has
        input.
        """
        started_at = time.time()
        self._paused = False
        self._replaying = False
        self._callbacks.play(song)
        self._history_metadata = self._offline_metadata(song)
        self._load_track(song)
        time.sleep(2)  # Give the backend time to load the track
        tracker = PlayTracker(getattr(song, "track_length", None))
        last = time.monotonic()

        while True:
            try:
                self._callbacks.pre_poll()
                self._ensure_started()
                self._loop_hook()

                now = time.monotonic()
                if not self._paused:
                    tracker.add(now - last)
                last = now
                if not self._replaying and tracker.due():
                    listened = getattr(self._callbacks, "listened", None)
                    if listened:
                        listened(song, started_at)

                readers, _, _ = select.select(
                    self._get_select_readers(), [], [], 1
                )

                for handle in readers:
                    if handle.fileno() == self._control_fd:
                        self._callbacks.input(handle.readline().strip(), song)
                    else:
                        value = self._read_from_process(handle)
                        if self._player_stopped(value):
                            self._offline_library.record_play(
                                self._history_metadata
                                or self._offline_metadata(song),
                                "pydora",
                            )
                            return
            finally:
                self._callbacks.post_poll()

    def end_station(self):
        """Stop playing the station"""
        raise StopIteration

    def play_station(self, station):
        """Play the station until something ends it

        This function will run forever until termintated by calling
        end_station.
        """
        for song in iterate_forever(station.get_playlist):
            try:
                self.play(song)
            except StopIteration:
                self.stop()
                return


class MPG123Player(BasePlayer):
    """Player Backend Using mpg123"""

    def __init__(self, callbacks, control_channel):
        super().__init__(callbacks, control_channel)
        self._cmd.extend(["-q", "-R", "--ignore-mime", "."])

    def _find_path(self):
        loc = which("mpg123")
        if not loc:
            raise PlayerUnusable("Unable to find mpg123")

        log.info("Using mpg123 at path %s", loc)
        return loc

    def _load_track(self, song):
        if song.encoding != "mp3":
            raise UnsupportedEncoding("mpg123 only supports mp3 files")

        self._load_url(self._playback_url(song))

    def _load_url(self, url):
        self._send_cmd("load {}".format(url))

    def _post_start(self):
        # Only output play status in the player stdout
        self._send_cmd("silence")

    def _player_stopped(self, value):
        return value.startswith(b"@P") and value.decode("utf-8")[3] == "0"

    def raise_volume(self):
        return

    def lower_volume(self):
        return


class VLCPlayer(BasePlayer):
    POLL_INTERVAL = 3
    CHUNK_SIZE = 1024
    VOL_STEPS = 5

    def __init__(self, callbacks, control_channel):
        super().__init__(callbacks, control_channel)
        self._cmd.extend(["-I", "rc", "--advanced", "--rc-fake-tty", "-q"])
        self._last_poll = 0

    def _find_path(self):
        loc = which("vlc")
        if not loc:  # Mac OS X
            loc = which("VLC", path="/Applications/VLC.app/Contents/MacOS")

        if not loc:
            raise PlayerUnusable("Unable to find VLC")

        log.info("Using vlc at location %s", loc)
        return loc

    def raise_volume(self):
        self._send_cmd("volup {}".format(self.VOL_STEPS))

    def lower_volume(self):
        self._send_cmd("voldown {}".format(self.VOL_STEPS))

    def _post_start(self):
        """Set stdout to non-blocking

        VLC does not always return a newline when reading status so in order to
        be lazy and still use the read API without caring about how much output
        there is we switch stdout to nonblocking mode and just read a large
        chunk of datin order to be lazy and still use the read API without
        caring about how much output there is we switch stdout to nonblocking
        mode and just read a large chunk of data.
        """
        flags = fcntl.fcntl(self._process.stdout, fcntl.F_GETFL)
        fcntl.fcntl(self._process.stdout, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def _read_from_process(self, handle):
        return handle.read(self.CHUNK_SIZE).strip()

    def _load_track(self, song):
        self._load_url(self._playback_url(song))

    def _load_url(self, url):
        self._send_cmd("add {}".format(url))

    def _player_stopped(self, value):
        return "state stopped" in value.decode("utf-8")

    def _loop_hook(self):
        if (time.time() - self._last_poll) >= self.POLL_INTERVAL:
            self._send_cmd("status")
            self._last_poll = time.time()


class RemoteVLC(VLCPlayer):
    def __init__(self, host, port, callbacks, control_channel):
        self._connect_to = (host, int(port))
        self._control_sock = None
        super().__init__(callbacks, control_channel)

    def _get_select_readers(self):
        return [self._control_channel, self._control_sock]

    def _send_cmd(self, cmd):
        self._control_sock.sendall("{}\n".format(cmd).encode("utf-8"))

    def _load_track(self, song):
        remote_root = os.environ.get("PYDORA_REMOTE_MELODICA_DIR")
        music_id = str(getattr(song, "music_id", None) or "")
        cached = self._offline_library.lookup(self._offline_metadata(song))
        if (
            remote_root
            and cached
            and music_id
            and all(
                character.isalnum() or character in "._-"
                for character in music_id
            )
        ):
            playback_url = os.path.join(
                remote_root, "by-music-id", music_id + ".mp3"
            )
        else:
            playback_url = self._playback_url(song, use_cached=False)
        self._send_cmd("add {}".format(playback_url))

    def play_previous(self, song):
        previous = self._offline_library.previous_track(
            self._offline_metadata(song)
        )
        remote_root = os.environ.get("PYDORA_REMOTE_MELODICA_DIR")
        music_id = str((previous or {}).get("music_id") or "")
        if not (
            remote_root
            and previous
            and music_id
            and all(
                character.isalnum() or character in "._-"
                for character in music_id
            )
        ):
            return False
        self._history_metadata = previous
        self._load_url(
            os.path.join(remote_root, "by-music-id", music_id + ".mp3")
        )
        return True

    def _read_from_process(self, handle):
        return handle.recv(self.CHUNK_SIZE).strip()

    def _ensure_started(self):
        if not self._control_sock:
            log.debug("Connecting to remote VLC at %r", self._connect_to)
            self._control_sock = socket.create_connection(self._connect_to)
            self._control_sock.setblocking(False)

    def _find_path(self):
        try:
            self._ensure_started()
        except socket.error:
            raise PlayerUnusable("Unable to connect to VLC")

    def _post_start(self):
        # This is a NOOP for network VLC
        pass
