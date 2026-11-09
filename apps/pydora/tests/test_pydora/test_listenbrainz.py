import io
import json
import os
import tempfile
import urllib.error
from unittest import TestCase

from pydora import listenbrainz as lb

TOKEN = "sgs_secret_test_token_value"


class FakeServer:
    """Stands in for urlopen; answers with the next status in `statuses`."""

    def __init__(self, statuses=None):
        self.statuses = list(statuses or [])
        self.requests = []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data.decode()) if req.data else None
        self.requests.append((req.full_url, dict(req.header_items()), body))
        status = self.statuses.pop(0) if self.statuses else 200
        if status == "down":
            raise urllib.error.URLError(ConnectionRefusedError())
        if status != 200:
            raise urllib.error.HTTPError(
                req.full_url, status, "x", {}, io.BytesIO(b"{}")
            )
        if req.full_url.endswith("validate-token"):
            data = b'{"valid": true, "user_name": "u"}'
        else:
            data = b'{"status": "ok"}'
        return io.BytesIO(data)


class TestRule(TestCase):
    def test_counts(self):
        self.assertFalse(lb.listen_counts(30, 30))
        self.assertFalse(lb.listen_counts(None, 100))
        self.assertTrue(lb.listen_counts(31, 15.5))
        self.assertFalse(lb.listen_counts(200, 99))
        self.assertTrue(lb.listen_counts(200, 100))
        self.assertFalse(lb.listen_counts(1000, 239))
        self.assertTrue(lb.listen_counts(1000, 240))

    def test_tracker_once(self):
        t = lb.PlayTracker(100)
        t.add(49)
        self.assertFalse(t.due())
        t.add(1)
        self.assertTrue(t.due())
        t.add(10)
        self.assertFalse(t.due())


class TestMetadata(TestCase):
    def test_fields(self):
        m = lb.track_metadata(
            "A",
            "T",
            album="L",
            duration_s=200,
            art_url="http://cont.pandora.com/x.jpg",
            station="My Station",
            client="pydora",
            client_version="1",
        )
        info = m["additional_info"]
        self.assertEqual(m["release_name"], "L")
        self.assertEqual(info["duration_ms"], 200000)
        self.assertEqual(info["art_url"], "http://cont.pandora.com/x.jpg")
        self.assertEqual(info["station_name"], "My Station")
        self.assertEqual(info["music_service"], "pandora.com")
        self.assertEqual(info["submission_client_version"], "1")
        self.assertFalse(any(k.startswith("pandora_") for k in info))

    def test_no_art(self):
        m = lb.track_metadata("A", "T", art_url="data:x")
        self.assertNotIn("art_url", m["additional_info"])
        self.assertNotIn("release_name", m)

    def test_base(self):
        self.assertEqual(lb.normalize_base(""), lb.SPACEGHOST_URL)
        self.assertEqual(
            lb.normalize_base("https://api.listenbrainz.org/1/"),
            "https://api.listenbrainz.org",
        )


class TestClient(TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.queue = os.path.join(self.dir.name, "q", "queue.json")
        self.meta = lb.track_metadata("A", "T")

    def tearDown(self):
        self.dir.cleanup()

    def client(self, server):
        return lb.ListenBrainzClient(
            "https://example.test/scrobble/",
            TOKEN,
            queue_path=self.queue,
            urlopen=server,
        )

    def test_now_playing(self):
        s = FakeServer()
        self.assertTrue(self.client(s).now_playing(self.meta))
        url, headers, body = s.requests[0]
        self.assertEqual(url, "https://example.test/scrobble/1/submit-listens")
        self.assertEqual(headers["Authorization"], "Token " + TOKEN)
        self.assertEqual(body["listen_type"], "playing_now")
        self.assertNotIn("listened_at", body["payload"][0])

    def test_now_playing_not_queued(self):
        c = self.client(FakeServer([503]))
        self.assertFalse(c.now_playing(self.meta))
        self.assertEqual(c.pending(), 0)

    def test_listen_sent(self):
        s = FakeServer()
        self.assertEqual(self.client(s).listen(self.meta, 1700000000), "sent")
        body = s.requests[0][2]
        self.assertEqual(body["listen_type"], "single")
        self.assertEqual(body["payload"][0]["listened_at"], 1700000000)

    def test_queue_and_flush(self):
        s = FakeServer(["down", 503, 429])
        c = self.client(s)
        self.assertEqual(c.listen(self.meta, 1), "queued")
        self.assertEqual(c.listen(self.meta, 2), "queued")
        self.assertEqual(c.listen(self.meta, 3), "queued")
        self.assertEqual(c.pending(), 3)
        with open(self.queue) as f:
            self.assertNotIn(TOKEN, f.read())
        # next listen goes through, then the queue goes as one import
        self.assertEqual(c.listen(self.meta, 4), "sent")
        self.assertEqual(c.pending(), 0)
        body = s.requests[-1][2]
        self.assertEqual(body["listen_type"], "import")
        self.assertEqual(
            [p["listened_at"] for p in body["payload"]], [1, 2, 3]
        )

    def test_queue_survives_restart(self):
        self.client(FakeServer([503])).listen(self.meta, 5)
        s = FakeServer()
        self.assertEqual(self.client(s).flush(), 1)
        self.assertEqual(s.requests[0][2]["listen_type"], "single")

    def test_bad_listen_dropped(self):
        c = self.client(FakeServer([400]))
        self.assertEqual(c.listen(self.meta, 1), "dropped")
        self.assertEqual(c.pending(), 0)

    def test_unauthorized_kept(self):
        c = self.client(FakeServer([401]))
        self.assertEqual(c.listen(self.meta, 1), "queued")
        self.assertNotIn(TOKEN, c.last_error)
        self.assertNotIn(TOKEN, repr(c))

    def test_import_with_one_bad_listen(self):
        c = self.client(FakeServer([503, 503]))
        c.listen(self.meta, 1)
        c.listen(self.meta, 2)
        # import refused, then 1 is refused alone, 2 goes through
        s = FakeServer([400, 400, 200])
        c._urlopen = s
        self.assertEqual(c.flush(), 1)
        self.assertEqual(c.pending(), 0)

    def test_queue_cap(self):
        c = self.client(FakeServer())
        c._enqueue([{"listened_at": i} for i in range(lb.QUEUE_MAX + 5)])
        self.assertEqual(c.pending(), lb.QUEUE_MAX)

    def test_validate(self):
        self.assertEqual(self.client(FakeServer()).validate(), (True, "u"))

    def test_no_token(self):
        c = lb.ListenBrainzClient("", "", urlopen=FakeServer())
        self.assertFalse(c.configured)
        self.assertFalse(c.now_playing(self.meta))

    def test_worker(self):
        w = lb.Worker()
        out = []
        w.send(out.append, 1)
        w.send(lambda: 1 / 0)
        w.send(out.append, 2)
        w.join()
        self.assertEqual(out, [1, 2])
