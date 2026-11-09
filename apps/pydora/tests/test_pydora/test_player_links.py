from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from pydora.player import PlayerApp


def station(name, id_="1", token="t1"):
    return SimpleNamespace(name=name, id=id_, token=token)


class TestOpenLink(TestCase):
    def setUp(self):
        self.app = PlayerApp()
        self.app.screen = Mock()
        self.app.client = Mock()
        self.app.stations = [station("Modest Mouse Radio", "11", "tok11")]

    def answer(self, text):
        self.app.screen.get_string.return_value = text

    def test_unsupported(self):
        self.assertIsNone(self.app.open_link("listen://artist/x?autoplay=1"))
        self.app.screen.print_error.assert_called_with(
            "That link isn't supported"
        )
        self.app.screen.get_string.assert_not_called()

    def test_artist_asks_first(self):
        self.answer("n")
        self.assertIsNone(self.app.open_link("listen://artist/Modest%20Mouse"))
        self.app.screen.get_string.assert_called_with(
            "Start Modest Mouse station? [y/N] "
        )
        self.app.client.search.assert_not_called()

    def test_artist_existing_station(self):
        self.answer("y")
        got = self.app.open_link("listen://artist/Modest%20Mouse")
        self.assertIs(got, self.app.stations[0])
        self.app.client.create_station.assert_not_called()

    def test_artist_creates_station(self):
        self.answer("yes")
        made = station("Sigur Ros Radio", "22", "tok22")
        self.app.client.search.return_value = SimpleNamespace(
            artists=[
                SimpleNamespace(artist="Sigur Ros Tribute", token="R1"),
                SimpleNamespace(artist="Sigur Ros", token="R2"),
            ],
            genre_stations=[],
        )
        self.app.client.create_station.return_value = made
        got = self.app.open_link(
            "https://spacegho.st/listen/artist/Sigur%20Ros"
        )
        self.assertIs(got, made)
        self.app.client.create_station.assert_called_with(search_token="R2")

    def test_genre_none_found(self):
        self.answer("y")
        self.app.client.search.return_value = SimpleNamespace(
            artists=[], genre_stations=[]
        )
        self.assertIsNone(self.app.open_link("web+listen://genre/zydeco"))
        self.app.screen.print_error.assert_called_with(
            "Pandora has no genre called zydeco"
        )

    def test_station_in_list(self):
        self.answer("y")
        got = self.app.open_link("listen://station/tok11")
        self.assertIs(got, self.app.stations[0])

    def test_station_not_in_list(self):
        self.assertIsNone(self.app.open_link("listen://station/999"))
        self.app.screen.print_error.assert_called_with(
            "That station isn't in your station list"
        )
        self.app.screen.get_string.assert_not_called()

    def test_other_targets_open_browser(self):
        with patch("pydora.player.webbrowser.open") as browser:
            self.assertIsNone(
                self.app.open_link("listen://map/neon-plains/synthwave-reach")
            )
        browser.assert_called_with(
            "https://spacegho.st/melodica/map/"
            "?land=neon-plains&province=synthwave-reach"
        )
        self.app.screen.get_string.assert_not_called()
