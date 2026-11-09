"""The cases of melodica-scrobble tests/listen-uri.test.mjs, ported as is."""

from unittest import TestCase

from pydora.listen_uri import listen_uri, parse_listen_uri, route_of

A64 = "a" * 64


class TestListenUri(TestCase):
    def test_parses_every_target_in_all_three_forms(self):
        cases = [
            (
                "listen://artist/Modest%20Mouse",
                {"target": "artist", "name": "Modest Mouse"},
            ),
            (
                "web+listen://genre/thrash%20metal",
                {"target": "genre", "name": "thrash metal"},
            ),
            (
                "https://spacegho.st/listen/station/4123456789012345",
                {"target": "station", "station": "4123456789012345"},
            ),
            (
                "listen://track/" + A64 + "?t=95",
                {"target": "track", "track": A64, "t": 95},
            ),
            (
                "listen://map/neon-plains/synthwave-reach",
                {
                    "target": "map",
                    "land": "neon-plains",
                    "province": "synthwave-reach",
                },
            ),
            (
                "listen://map/neon-plains",
                {"target": "map", "land": "neon-plains"},
            ),
            (
                "listen://user/knewter",
                {"target": "user", "username": "knewter"},
            ),
            ("listen://listens", {"target": "listens"}),
            ("LISTEN://Leaderboard/", {"target": "leaderboard"}),
            (
                "listen://artist/Sigur%20R%C3%B3s",
                {"target": "artist", "name": "Sigur Rós"},
            ),
        ]
        for u, want in cases:
            p = parse_listen_uri(u)
            self.assertTrue(p, u)
            for k, v in want.items():
                self.assertEqual(p[k], v, "{} {}".format(u, k))
            self.assertEqual(parse_listen_uri(p["https"])["uri"], p["uri"])
            self.assertEqual(parse_listen_uri(p["web"])["uri"], p["uri"])
        self.assertIsNone(parse_listen_uri("listen://artist/AC%2FDC"))
        guns = listen_uri({"target": "artist", "name": "Guns N' Roses"})
        self.assertEqual(
            guns["https"],
            "https://spacegho.st/listen/artist/Guns%20N'%20Roses",
        )
        self.assertEqual(
            parse_listen_uri(guns["uri"])["name"], "Guns N' Roses"
        )

    def test_rejects_anything_not_allow_listed(self):
        bad = [
            "listen://http://evil.example",
            "listen://url/https%3A%2F%2Fevil.example",
            "listen://artist",
            "listen://artist/a/b",
            "listen://artist/%00x",
            "listen://artist/%2e%2e",
            "listen://artist/" + "x" * 201,
            "listen://artist/%E0%A4%A",
            "listen://artist/ x",
            "listen://artist/x?autoplay=1",
            "listen://track/zzz!?t=1",
            "listen://track/abc?t=999999",
            "listen://track/abc?t=1&t=2",
            "listen://map/Neon_Plains",
            "listen://map/a/b/c",
            "listen://user/A",
            "listen://station/12-34",
            "listen://artist/x#frag",
            "javascript:alert(1)",
            "https://evil.example/listen/artist/x",
            "https://spacegho.st/listen/../oauth/admin",
            "listen://listens/extra",
            "listen://artist/<script>",
            42,
            None,
        ]
        for u in bad:
            self.assertIsNone(parse_listen_uri(u), str(u))
        self.assertIsNone(listen_uri({"target": "url", "name": "x"}))
        self.assertIsNone(listen_uri({"target": "artist", "name": ".."}))
        self.assertTrue(listen_uri({"target": "artist", "name": "..."}))
        self.assertIsNone(listen_uri({"target": "user", "username": "NO"}))

    def test_routes_stay_on_spacegho_st_melodica_pages(self):
        self.assertEqual(
            route_of(parse_listen_uri("listen://artist/Modest%20Mouse")),
            "/melodica/app/?seed=artist:Modest%20Mouse",
        )
        self.assertEqual(
            route_of(
                parse_listen_uri("listen://map/neon-plains/synthwave-reach")
            ),
            "/melodica/map/?land=neon-plains&province=synthwave-reach",
        )
        self.assertEqual(
            route_of(parse_listen_uri("listen://track/abc?t=5")),
            "/melodica/listens/?track=abc&t=5",
        )
        for u in [
            "listen://listens",
            "listen://leaderboard",
            "listen://user/knewter",
            "listen://station/123",
            "listen://genre/dance",
        ]:
            self.assertRegex(route_of(parse_listen_uri(u)), r"^/melodica/")
