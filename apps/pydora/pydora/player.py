#!/usr/bin/env python
"""
Sample Barebones Pandora Player

This is a very simple Pandora player that streams music from Pandora. It
requires mpg123 or VLC to function. No songs are downloaded, they are streamed
directly from Pandora's servers.
"""
import os
import sys
import logging
import argparse
import webbrowser
from configparser import ConfigParser
from pandora import __version__, clientbuilder

from .utils import Colors, Screen
from . import listenbrainz
from .listen_uri import parse_listen_uri, web_url
from .audio_backend import RemoteVLC
from .audio_backend import MPG123Player, VLCPlayer
from .audio_backend import UnsupportedEncoding, PlayerUnusable


class PlayerCallbacks:
    """Interface for Player Callbacks

    This class simply exists to document the interface for callback
    implementers implementers need not extend this class.
    """

    def play(self, song):
        """Called once when a song starts playing"""
        pass

    def pre_poll(self):
        """Called before polling for process status"""
        pass

    def post_poll(self):
        """Called after polling for process status"""
        pass

    def input(self, value, song):
        """Called after user input during song playback"""
        pass

    def listened(self, song, started_at):
        """Called once per play, when the song has played long enough to
        count as a listen (half its length or four minutes)"""
        pass


class PlayerApp:
    CMD_MAP = {
        "n": ("play next song", "skip_song"),
        "r": ("replay previous cached song", "previous_song"),
        "l": ("list offline library", "list_library"),
        "p": ("pause/resume song", "pause_song"),
        "s": ("stop playing station", "stop_station"),
        "d": ("dislike song", "dislike_song"),
        "u": ("like song", "like_song"),
        "b": ("bookmark song", "bookmark_song"),
        "a": ("bookmark artist", "bookmark_artist"),
        "S": ("sleep song for 30 days", "sleep_song"),
        "Q": ("quit player", "quit"),
        "vu": ("raise volume", "raise_volume"),
        "vd": ("lower volume", "lower_volume"),
        "?": ("display this help", "help"),
    }

    def __init__(self):
        self.client = None
        self.screen = Screen()
        self.scrobbler = None
        self.scrobble_worker = None
        self.station = None

    def get_scrobbler(self):
        """The ListenBrainz-compatible scrobbler, or None without a token.

        Read from the [listenbrainz] section of the pydora config (url, token)
        or PYDORA_LISTENBRAINZ_URL / PYDORA_LISTENBRAINZ_TOKEN. The url
        defaults to spacegho.st.
        """
        url = os.environ.get("PYDORA_LISTENBRAINZ_URL", "")
        token = os.environ.get("PYDORA_LISTENBRAINZ_TOKEN", "")
        path = os.path.expanduser(
            os.environ.get("PYDORA_CFG", "")
            or clientbuilder.PydoraConfigFileBuilder.DEFAULT_CONFIG_FILE
        )
        if os.path.exists(path):
            cfg = ConfigParser()
            try:
                cfg.read(path)
            except Exception:
                cfg = None
            if cfg is not None and cfg.has_section("listenbrainz"):
                url = url or cfg.get("listenbrainz", "url", fallback="")
                token = token or cfg.get("listenbrainz", "token", fallback="")
        if not token.strip():
            return None
        return listenbrainz.ListenBrainzClient(
            url,
            token,
            queue_path=listenbrainz_queue_path(),
            client="pydora",
            client_version=__version__,
        )

    def _song_metadata(self, song):
        return self.scrobbler.metadata(
            song.artist_name,
            song.song_name,
            album=song.album_name,
            duration_s=song.track_length,
            art_url=song.album_art_url,
            station=getattr(self.station, "name", None),
        )

    def listened(self, song, started_at):
        """Listen callback: the song has played long enough to count"""
        if self.scrobbler and not song.is_ad:
            meta = self._song_metadata(song)
            self.scrobble_worker.send(
                self.scrobbler.listen, meta, int(started_at)
            )

    def get_player(self, vlc_net=None):
        # The user must explicitly request network VLC so we should always
        # honor that request, to this end we try network first and fail hard
        # if that isn't available.
        if vlc_net:
            try:
                host, port = vlc_net.split(":")
                player = RemoteVLC(host, port, self, sys.stdin)
                Screen.print_success("Using Remote VLC")
                return player
            except PlayerUnusable:
                Screen.print_error("Unable to connect to vlc")
                raise

        try:
            player = VLCPlayer(self, sys.stdin)
            self.screen.print_success("Using VLC")
            return player
        except PlayerUnusable:
            pass

        try:
            player = MPG123Player(self, sys.stdin)
            self.screen.print_success("Using mpg123")
            return player
        except PlayerUnusable:
            pass

        self.screen.print_error("Unable to find a player")
        sys.exit(1)

    def get_client(self):
        cfg_file = os.environ.get("PYDORA_CFG", "")
        builder = clientbuilder.PydoraConfigFileBuilder(cfg_file)
        if builder.file_exists:
            return builder.build()

        builder = clientbuilder.PianobarConfigFileBuilder()
        if builder.file_exists:
            return builder.build()

        if not self.client:
            self.screen.print_error("No valid config found")
            sys.exit(1)

    def station_selection_menu(self, error=None):
        """Format a station menu and make the user select a station"""
        self.screen.clear()

        if error:
            self.screen.print_error("{}\n".format(error))

        for i, station in enumerate(self.stations):
            i = "{:>3}".format(i)
            print("{}: {}".format(Colors.yellow(i), station.name))

        return self.stations[self.screen.get_integer("Station: ")]

    def play(self, song):
        """Play callback"""
        if self.scrobbler and not song.is_ad:
            meta = self._song_metadata(song)
            self.scrobble_worker.send(self.scrobbler.now_playing, meta)
        if song.is_ad:
            print("{} ".format(Colors.cyan("Advertisement")))
        else:
            print(
                "{} by {}".format(
                    Colors.cyan(song.song_name),
                    Colors.yellow(song.artist_name),
                )
            )

    def skip_song(self, song):
        if song.is_ad:
            self.screen.print_error("Cannot skip advertisements")
        else:
            self.player.stop()

    def previous_song(self, song):
        if not self.player.play_previous(song):
            self.screen.print_error("No previous cached track")

    def list_library(self, song):
        tracks = self.player.library()
        if not tracks:
            self.screen.print_error("Offline library is empty")
            return
        for index, track in enumerate(tracks, 1):
            print(
                "{:>4}  {} — {} ({})".format(
                    index,
                    track.get("artist", "Unknown Artist"),
                    track.get("title", "Unknown Title"),
                    track.get("album", "Unknown Album"),
                )
            )

    def pause_song(self, song):
        self.player.pause()

    def stop_station(self, song):
        self.player.end_station()

    def dislike_song(self, song):
        try:
            if song.thumbs_down():
                self.screen.print_success("Track disliked")
                self.player.stop()
            else:
                self.screen.print_error("Failed to dislike track")
        except NotImplementedError:
            self.screen.print_error("Cannot dislike this type of track")

    def like_song(self, song):
        try:
            if song.thumbs_up():
                self.screen.print_success("Track liked")
            else:
                self.screen.print_error("Failed to like track")
        except NotImplementedError:
            self.screen.print_error("Cannot like this type of track")

    def bookmark_song(self, song):
        try:
            if song.bookmark_song():
                self.screen.print_success("Bookmarked song")
            else:
                self.screen.print_error("Failed to bookmark song")
        except NotImplementedError:
            self.screen.print_error("Cannot bookmark this type of track")

    def bookmark_artist(self, song):
        try:
            if song.bookmark_artist():
                self.screen.print_success("Bookmarked artist")
            else:
                self.screen.print_error("Failed to bookmark artis")
        except NotImplementedError:
            self.screen.print_error(
                "Cannot bookmark artist for this type of track"
            )

    def sleep_song(self, song):
        try:
            if song.sleep():
                self.screen.print_success(
                    "Song will not be played for 30 days"
                )
                self.player.stop()
            else:
                self.screen.print_error("Failed to sleep song")
        except NotImplementedError:
            self.screen.print_error("Cannot sleep this type of track")

    def raise_volume(self, song):
        try:
            self.player.raise_volume()
        except NotImplementedError:
            self.screen.print_error("Cannot sleep this type of track")

    def lower_volume(self, song):
        try:
            self.player.lower_volume()
        except NotImplementedError:
            self.screen.print_error("Cannot sleep this type of track")

    def quit(self, song):
        if self.scrobble_worker:
            self.scrobble_worker.join()
        self.player.end_station()
        sys.exit(0)

    def help(self, song):
        print("")
        print(
            "\n".join(
                [
                    "\t{:>2} - {}".format(k, v[0])
                    for k, v in sorted(self.CMD_MAP.items())
                ]
            )
        )
        print("")

    def input(self, input, song):
        """Input callback, handles key presses"""
        try:
            cmd = getattr(self, self.CMD_MAP[input][1])
        except (IndexError, KeyError):
            return self.screen.print_error(
                "Invalid command {!r}!".format(input)
            )

        cmd(song)

    def pre_poll(self):
        self.screen.set_echo(False)

    def post_poll(self):
        self.screen.set_echo(True)

    def confirm(self, question):
        answer = self.screen.get_string("{} [y/N] ".format(question))
        return answer.strip().lower() in ("y", "yes")

    def _seed_station(self, target, name):
        """An artist or genre station: one already in the list, or a new one"""
        wanted = {name.lower(), "{} radio".format(name.lower())}
        for station in self.stations:
            if station.name and station.name.lower() in wanted:
                return station
        results = self.client.search(
            name, include_near_matches=True, include_genre_stations=True
        )
        if target == "artist":
            items = [(i.artist, i) for i in results.artists or []]
        else:
            items = [(i.station_name, i) for i in results.genre_stations or []]
        if not items:
            self.screen.print_error(
                "Pandora has no {} called {}".format(target, name)
            )
            return None
        exact = [i for n, i in items if n and n.lower() == name.lower()]
        item = exact[0] if exact else items[0][1]
        station = self.client.create_station(search_token=item.token)
        self.stations = self.client.get_station_list()
        return station

    def open_link(self, link):
        """Handle a listen:// link (docs/LISTEN-URI.md in melodica-scrobble).

        Returns the station to play once the user has said yes, else None.
        Nothing plays without that answer. Targets pydora cannot show open
        on spacegho.st in the browser.
        """
        p = parse_listen_uri(link)
        if not p:
            self.screen.print_error("That link isn't supported")
            return None
        target = p["target"]
        if target in ("artist", "genre"):
            if not self.confirm("Start {} station?".format(p["name"])):
                return None
            return self._seed_station(target, p["name"])
        if target == "station":
            for station in self.stations:
                if p["station"] in (station.id, station.token):
                    if self.confirm("Start {} station?".format(station.name)):
                        return station
                    return None
            self.screen.print_error("That station isn't in your station list")
            return None
        url = web_url(p)
        webbrowser.open(url)
        self.screen.print_success("Opened {}".format(url))
        return None

    def pre_flight_checks(self):
        # See #52, this key no longer passes some server-side check
        if self.client.partner_user == "iphone":
            self.screen.print_error(
                (
                    "The `iphone` partner key set is no longer compatible "
                    "with pydora. Please re-run pydora-configure to "
                    "re-generate your config file before continuing."
                )
            )
            sys.exit(1)

    def _parse_args(self):
        parser = argparse.ArgumentParser(
            description="command line Pandora player"
        )
        parser.add_argument(
            "--vlc-net",
            dest="vlc_net",
            help="connect to VLC over the network (host:port)",
        )
        parser.add_argument(
            "link",
            nargs="?",
            help=(
                "a listen:// link (or https://spacegho.st/listen/...) to "
                "open; asks before anything plays"
            ),
        )
        parser.add_argument(
            "-v",
            dest="verbose",
            action="store_true",
            help="enable verbose logging",
        )
        return parser.parse_args()

    def run(self):
        args = self._parse_args()

        if args.verbose:
            logging.basicConfig(level=logging.DEBUG)
        else:
            logging.basicConfig(level=logging.ERROR)

        self.player = self.get_player(args.vlc_net)
        self.player.start()

        self.client = self.get_client()
        self.stations = self.client.get_station_list()

        self.pre_flight_checks()

        self.scrobbler = self.get_scrobbler()
        if self.scrobbler:
            self.scrobble_worker = listenbrainz.Worker()
            self.scrobble_worker.send(self.scrobbler.flush)
            self.screen.print_success(
                "Scrobbling to {}".format(self.scrobbler.base)
            )

        error = None

        if args.link:
            station = self.open_link(args.link)
            if station:
                self.station = station
                try:
                    self.player.play_station(station)
                except UnsupportedEncoding as ex:
                    error = str(ex)
                except KeyboardInterrupt:
                    self.player.stop()
                    sys.exit(0)

        while True:
            try:
                station = self.station_selection_menu(error)
                error = None
            except IndexError:
                error = "Invalid station selection."
                continue
            except KeyboardInterrupt:
                sys.exit(0)

            self.station = station
            try:
                self.player.play_station(station)
            except UnsupportedEncoding as ex:
                error = str(ex)
            except KeyboardInterrupt:
                self.player.stop()
                sys.exit(0)


def listenbrainz_queue_path():
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser(
        "~/.local/share"
    )
    return os.path.join(base, "pydora", "listenbrainz-queue.json")


def main():
    PlayerApp().run()
