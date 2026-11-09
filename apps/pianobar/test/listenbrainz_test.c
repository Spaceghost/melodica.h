/* Unit tests for src/listenbrainz.c with an in-process transport.
 * Build and run: make test */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../src/listenbrainz.h"

#define TOKEN "sgs_unit_test_token_0123456789abcdef"

static int failures = 0;
#define CHECK(c) do { if (!(c)) { fprintf (stderr, "FAIL %s:%d: %s\n", \
		__FILE__, __LINE__, #c); failures++; } } while (0)

typedef struct {
	long statuses[64];
	size_t nstatus, calls;
	char *bodies[64];
	char *urls[64];
	bool authOk;
	char messages[8192];
} fake_t;

static long fakePost (void *ctx, const char *url, const char *auth,
		const char *body) {
	fake_t * const f = ctx;
	f->authOk = strcmp (auth, "Token " TOKEN) == 0;
	const size_t i = f->calls++;
	if (i < 64) {
		f->bodies[i] = strdup (body);
		f->urls[i] = strdup (url);
	}
	return i < f->nstatus ? f->statuses[i] : 200;
}

static void fakeReport (void *ctx, bool error, const char *msg) {
	fake_t * const f = ctx;
	(void) error;
	strncat (f->messages, msg, sizeof (f->messages) - strlen (f->messages) - 2);
	strcat (f->messages, "\n");
}

static void fakeReset (fake_t *f) {
	for (size_t i = 0; i < 64 && i < f->calls; i++) {
		free (f->bodies[i]);
		free (f->urls[i]);
	}
	memset (f, 0, sizeof (*f));
}

static size_t countLines (const char *path) {
	FILE * const f = fopen (path, "r");
	if (f == NULL) {
		return 0;
	}
	size_t n = 0;
	int c;
	while ((c = fgetc (f)) != EOF) {
		n += c == '\n';
	}
	fclose (f);
	return n;
}

static void testRule (void) {
	CHECK (!BarLbCounts (30, 30));
	CHECK (!BarLbCounts (0, 1000));
	CHECK (BarLbCounts (31, 16));
	CHECK (!BarLbCounts (31, 15));
	CHECK (BarLbCounts (200, 100));
	CHECK (!BarLbCounts (200, 99));
	CHECK (BarLbCounts (600, 240));
	CHECK (!BarLbCounts (600, 239));
}

static void testUrls (void) {
	char *u = BarLbResolveUrl ("spacegho.st");
	CHECK (strcmp (u, "https://spacegho.st/scrobble") == 0); free (u);
	u = BarLbResolveUrl (NULL);
	CHECK (strcmp (u, "https://spacegho.st/scrobble") == 0); free (u);
	u = BarLbResolveUrl ("listenbrainz");
	CHECK (strcmp (u, "https://api.listenbrainz.org") == 0); free (u);
	u = BarLbResolveUrl ("http://127.0.0.1:9/x//");
	CHECK (strcmp (u, "http://127.0.0.1:9/x") == 0); free (u);
}

static void testMetadata (void) {
	char *m = BarLbTrackMetadata ("A \"B\"", "T\\1", "Alb", "http://cont.p-cdn.us/x.jpg",
			"Jazz Radio", 200, "pianobar", "1.0");
	CHECK (strcmp (m, "{\"artist_name\":\"A \\\"B\\\"\",\"track_name\":\"T\\\\1\","
			"\"release_name\":\"Alb\",\"additional_info\":{"
			"\"submission_client\":\"pianobar\",\"submission_client_version\":\"1.0\","
			"\"media_player\":\"pianobar\",\"music_service\":\"pandora.com\","
			"\"music_service_name\":\"Pandora\",\"duration_ms\":200000,"
			"\"art_url\":\"http://cont.p-cdn.us/x.jpg\",\"station_name\":\"Jazz Radio\"}}") == 0);
	free (m);
	m = BarLbTrackMetadata ("A", "T", NULL, "data:x", NULL, 0, "pianobar", "");
	CHECK (strstr (m, "art_url") == NULL);
	CHECK (strstr (m, "release_name") == NULL);
	CHECK (strstr (m, "duration_ms") == NULL);
	CHECK (strstr (m, "pandora_") == NULL);
	free (m);
	m = BarLbTrackMetadata ("A\x01", "T", NULL, NULL, NULL, 0, "p", "");
	CHECK (strstr (m, "A\\u0001") != NULL);
	free (m);
}

static void testFlow (const char *queue) {
	fake_t f = {0};
	BarLb_t lb;
	remove (queue);
	CHECK (!BarLbInit (&lb, "spacegho.st", "", queue, "pianobar", "1", fakePost,
			fakeReport, &f));
	CHECK (BarLbInit (&lb, "http://fake/scrobble", TOKEN, queue, "pianobar",
			"1", fakePost, fakeReport, &f));

	/* playing_now, then nothing until it counts, then one single */
	BarLbSongStart (&lb, "Artist", "Song", "Album", "http://a/b.jpg", "St",
			200, 1700000000LL);
	CHECK (f.calls == 1);
	CHECK (f.authOk);
	CHECK (strcmp (f.urls[0], "http://fake/scrobble/1/submit-listens") == 0);
	CHECK (strstr (f.bodies[0], "\"listen_type\":\"playing_now\"") != NULL);
	CHECK (strstr (f.bodies[0], "listened_at") == NULL);
	BarLbProgress (&lb, 200, 99);
	CHECK (f.calls == 1);
	BarLbProgress (&lb, 200, 100);
	CHECK (f.calls == 2);
	CHECK (strstr (f.bodies[1], "{\"listen_type\":\"single\",\"payload\":"
			"[{\"listened_at\":1700000000,\"track_metadata\":{\"artist_name\":\"Artist\"") == f.bodies[1]);
	BarLbProgress (&lb, 200, 150);
	CHECK (f.calls == 2);
	BarLbSongEnd (&lb);

	/* songs only */
	BarLbSongStart (&lb, "", "Song", NULL, NULL, NULL, 200, 1700000100LL);
	BarLbProgress (&lb, 200, 200);
	CHECK (f.calls == 2);

	/* a short track never counts */
	BarLbSongStart (&lb, "A", "Short", NULL, NULL, NULL, 30, 1700000200LL);
	BarLbProgress (&lb, 30, 30);
	CHECK (f.calls == 3);

	/* 503: queued, not retried before the back-off */
	f.nstatus = 5;
	f.statuses[3] = 200; /* playing_now */
	f.statuses[4] = 503; /* single */
	BarLbSongStart (&lb, "A", "Offline", NULL, NULL, NULL, 100, 1700000300LL);
	BarLbProgress (&lb, 100, 50);
	CHECK (f.calls == 5);
	CHECK (lb.queued == 1);
	CHECK (countLines (queue) == 1);
	BarLbTick (&lb, time (NULL));
	CHECK (f.calls == 5);
	/* due: one import, queue emptied */
	BarLbTick (&lb, lb.nextRetry);
	CHECK (f.calls == 6);
	CHECK (strstr (f.bodies[5], "{\"listen_type\":\"import\",\"payload\":"
			"[{\"listened_at\":1700000300,") == f.bodies[5]);
	CHECK (lb.queued == 0);
	CHECK (countLines (queue) == 0);

	/* 400 on a single: dropped */
	f.nstatus = 8;
	f.statuses[6] = 200;
	f.statuses[7] = 400;
	BarLbSongStart (&lb, "A", "Bad", NULL, NULL, NULL, 100, 1700000400LL);
	BarLbProgress (&lb, 100, 50);
	CHECK (lb.queued == 0);

	/* 401: kept, user told; a later success flushes the queue */
	f.nstatus = 12;
	f.statuses[8] = 401;
	f.statuses[9] = 401;
	f.statuses[10] = 200; /* playing_now */
	f.statuses[11] = 200; /* single, then the flush */
	BarLbSongStart (&lb, "A", "Refused", NULL, NULL, NULL, 100, 1700000500LL);
	BarLbProgress (&lb, 100, 50);
	CHECK (lb.queued == 1);
	CHECK (strstr (f.messages, "refused") != NULL);
	BarLbSongStart (&lb, "A", "Back", NULL, NULL, NULL, 100, 1700000600LL);
	BarLbProgress (&lb, 100, 50);
	CHECK (f.calls == 13);
	CHECK (strstr (f.bodies[12], "\"import\"") != NULL);
	CHECK (strstr (f.bodies[12], "Refused") != NULL);
	CHECK (lb.queued == 0);

	/* the queue survives a restart */
	f.nstatus = 15;
	f.statuses[13] = 0;
	f.statuses[14] = 0;
	BarLbSongStart (&lb, "A", "Saved", NULL, NULL, NULL, 100, 1700000700LL);
	BarLbProgress (&lb, 100, 50);
	BarLbDestroy (&lb);
	CHECK (BarLbInit (&lb, "http://fake/scrobble", TOKEN, queue, "pianobar",
			"1", fakePost, fakeReport, &f));
	CHECK (lb.queued == 1);
	BarLbTick (&lb, time (NULL));
	CHECK (lb.queued == 0);
	CHECK (strstr (f.bodies[15], "Saved") != NULL);

	/* the token is never in a body, a message or the queue */
	for (size_t i = 0; i < f.calls && i < 64; i++) {
		CHECK (strstr (f.bodies[i], TOKEN) == NULL);
	}
	CHECK (strstr (f.messages, TOKEN) == NULL);
	BarLbDestroy (&lb);
	fakeReset (&f);
}

static void testCap (const char *queue) {
	fake_t f = {0};
	BarLb_t lb;
	remove (queue);
	CHECK (BarLbInit (&lb, "http://fake", TOKEN, queue, "pianobar", "1",
			fakePost, fakeReport, &f));
	f.nstatus = 64;
	for (size_t i = 0; i < 64; i++) {
		f.statuses[i] = 503;
	}
	/* fill past the cap directly: 1003 listens */
	FILE *q = fopen (queue, "w");
	for (int i = 0; i < 1003; i++) {
		fprintf (q, "{\"listened_at\":%d,\"track_metadata\":{\"artist_name\":\"A\",\"track_name\":\"T\"}}\n",
				1700000000 + i);
	}
	fclose (q);
	BarLbDestroy (&lb);
	CHECK (BarLbInit (&lb, "http://fake", TOKEN, queue, "pianobar", "1",
			fakePost, fakeReport, &f));
	CHECK (lb.queued == 1003);
	BarLbSongStart (&lb, "A", "One more", NULL, NULL, NULL, 100, 1700009999LL);
	BarLbProgress (&lb, 100, 50);
	CHECK (countLines (queue) == BAR_LB_QUEUE_MAX);
	CHECK (lb.queued == BAR_LB_QUEUE_MAX);
	/* a flush sends batches of at most 100 */
	f.nstatus = 0;
	BarLbFlush (&lb);
	CHECK (lb.queued == 0);
	CHECK (countLines (queue) == 0);
	BarLbDestroy (&lb);
	fakeReset (&f);
}

int main (void) {
	char queue[] = "/tmp/lbtest-XXXXXX";
	const int fd = mkstemp (queue);
	assert (fd >= 0);
	close (fd);
	testRule ();
	testUrls ();
	testMetadata ();
	testFlow (queue);
	testCap (queue);
	remove (queue);
	if (failures) {
		fprintf (stderr, "%d failure(s)\n", failures);
		return 1;
	}
	printf ("listenbrainz: all tests passed\n");
	return 0;
}
