/* End-to-end check of src/listenbrainz.c over libcurl against a real server.
 *
 *   listenbrainz_e2e BASE_URL QUEUE_FILE TRACK_NAME < token
 *
 * Reads the token from stdin (never from argv, so it stays out of process
 * listings), sends now playing and one listen for "Test Artist" - TRACK_NAME
 * (200 s, played 100 s), then flushes the queue once. Prints each HTTP status. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../src/listenbrainz.h"
#include "../src/listenbrainz_curl.h"

static BarLbCurl_t http;

static long post (void *ctx, const char *url, const char *auth, const char *body) {
	(void) ctx;
	const long s = BarLbCurlPost (&http, url, auth, body);
	printf ("POST %s -> %ld (%s)\n", url, s,
			strstr (body, "\"playing_now\"") ? "playing_now" :
			strstr (body, "\"single\"") ? "single" : "import");
	return s;
}

static void report (void *ctx, bool error, const char *msg) {
	(void) ctx;
	printf ("%s %s\n", error ? "ERR" : "INFO", msg);
}

int main (int argc, char **argv) {
	if (argc != 4) {
		fprintf (stderr, "usage: %s BASE_URL QUEUE_FILE TRACK_NAME < token\n", argv[0]);
		return 2;
	}
	char token[512];
	if (fgets (token, sizeof (token), stdin) == NULL) {
		return 2;
	}
	token[strcspn (token, "\r\n")] = '\0';
	curl_global_init (CURL_GLOBAL_DEFAULT);
	http.timeout = 10;
	BarLb_t lb;
	if (!BarLbInit (&lb, argv[1], token, argv[2], "pianobar", "e2e", post,
			report, NULL)) {
		return 2;
	}
	memset (token, 0, sizeof (token));
	printf ("queued at start: %lu\n", (unsigned long) lb.queued);
	BarLbSongStart (&lb, "Test Artist", argv[3], "Test Album",
			"http://cont.p-cdn.us/images/public/int/test.jpg", "Test Station",
			200, (long long) time (NULL) - 100);
	BarLbProgress (&lb, 200, 100);
	BarLbSongEnd (&lb);
	printf ("queued after listen: %lu\n", (unsigned long) lb.queued);
	BarLbFlush (&lb);
	printf ("queued after flush: %lu\n", (unsigned long) lb.queued);
	const unsigned long left = (unsigned long) lb.queued;
	BarLbDestroy (&lb);
	if (http.http != NULL) {
		curl_easy_cleanup (http.http);
	}
	curl_global_cleanup ();
	return left == 0 ? 0 : 1;
}
