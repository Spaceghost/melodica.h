/*
Copyright (c) 2026
	melodica contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "listenbrainz.h"

#define LINE_MAX_BYTES 16384
#define BACKOFF_MIN 60
#define BACKOFF_MAX 1800

/* growable string */
typedef struct {
	char *s;
	size_t len, cap;
	bool failed;
} buf_t;

static void bufAddN (buf_t *b, const char *s, size_t n) {
	if (b->failed) {
		return;
	}
	if (b->len + n + 1 > b->cap) {
		size_t cap = b->cap ? b->cap : 256;
		while (cap < b->len + n + 1) {
			cap *= 2;
		}
		char * const s2 = realloc (b->s, cap);
		if (s2 == NULL) {
			b->failed = true;
			return;
		}
		b->s = s2;
		b->cap = cap;
	}
	memcpy (b->s + b->len, s, n);
	b->len += n;
	b->s[b->len] = '\0';
}

static void bufAdd (buf_t *b, const char *s) {
	bufAddN (b, s, strlen (s));
}

static char *bufTake (buf_t *b) {
	if (b->failed) {
		free (b->s);
		return NULL;
	}
	if (b->s == NULL) {
		return calloc (1, 1);
	}
	return b->s;
}

static char *dupStr (const char *s) {
	const size_t n = strlen (s) + 1;
	char * const d = malloc (n);
	if (d != NULL) {
		memcpy (d, s, n);
	}
	return d;
}

static bool empty (const char *s) {
	return s == NULL || s[0] == '\0';
}

/* JSON string literal, UTF-8 passed through, control characters escaped */
static void bufJsonStr (buf_t *b, const char *s) {
	bufAdd (b, "\"");
	for (const unsigned char *p = (const unsigned char *) s; *p; p++) {
		char esc[8];
		switch (*p) {
			case '"': bufAdd (b, "\\\""); break;
			case '\\': bufAdd (b, "\\\\"); break;
			case '\n': bufAdd (b, "\\n"); break;
			case '\r': bufAdd (b, "\\r"); break;
			case '\t': bufAdd (b, "\\t"); break;
			default:
				if (*p < 0x20) {
					snprintf (esc, sizeof (esc), "\\u%04x", *p);
					bufAdd (b, esc);
				} else {
					bufAddN (b, (const char *) p, 1);
				}
		}
	}
	bufAdd (b, "\"");
}

static void bufKeyStr (buf_t *b, bool *first, const char *key,
		const char *value) {
	if (empty (value)) {
		return;
	}
	bufAdd (b, *first ? "" : ",");
	*first = false;
	bufJsonStr (b, key);
	bufAdd (b, ":");
	bufJsonStr (b, value);
}

char *BarLbResolveUrl (const char *url) {
	const char *u = url;
	if (empty (u) || strcmp (u, "spacegho.st") == 0) {
		u = BAR_LB_DEFAULT_URL;
	} else if (strcmp (u, "listenbrainz") == 0 ||
			strcmp (u, "listenbrainz.org") == 0) {
		u = BAR_LB_LISTENBRAINZ_URL;
	}
	char * const r = dupStr (u);
	if (r != NULL) {
		size_t n = strlen (r);
		while (n > 0 && r[n-1] == '/') {
			r[--n] = '\0';
		}
	}
	return r;
}

bool BarLbCounts (unsigned int lengthS, unsigned int playedS) {
	if (lengthS <= 30) {
		return false;
	}
	const unsigned int half = lengthS / 2 + lengthS % 2;
	return playedS >= (half < 240 ? half : 240);
}

char *BarLbTrackMetadata (const char *artist, const char *title,
		const char *album, const char *artUrl, const char *station,
		unsigned int lengthS, const char *client, const char *clientVersion) {
	buf_t b = {0};
	bool first = true;
	bufAdd (&b, "{");
	bufKeyStr (&b, &first, "artist_name", artist);
	bufKeyStr (&b, &first, "track_name", title);
	bufKeyStr (&b, &first, "release_name", album);
	bufAdd (&b, first ? "" : ",");
	bufAdd (&b, "\"additional_info\":{");
	bool f2 = true;
	bufKeyStr (&b, &f2, "submission_client", client);
	bufKeyStr (&b, &f2, "submission_client_version", clientVersion);
	bufKeyStr (&b, &f2, "media_player", client);
	bufKeyStr (&b, &f2, "music_service", "pandora.com");
	bufKeyStr (&b, &f2, "music_service_name", "Pandora");
	if (lengthS > 0) {
		char n[32];
		snprintf (n, sizeof (n), ",\"duration_ms\":%lu",
				(unsigned long) lengthS * 1000UL);
		bufAdd (&b, n);
	}
	/* exactly as Pandora gives it, http or https */
	if (!empty (artUrl) && (strncmp (artUrl, "http://", 7) == 0 ||
			strncmp (artUrl, "https://", 8) == 0)) {
		bufKeyStr (&b, &f2, "art_url", artUrl);
	}
	bufKeyStr (&b, &f2, "station_name", station);
	bufAdd (&b, "}}");
	return bufTake (&b);
}

static void report (BarLb_t *lb, bool error, const char *text) {
	if (lb->report == NULL) {
		return;
	}
	/* base is the server URL, never the token */
	char msg[512];
	snprintf (msg, sizeof (msg), "Scrobbling (%s): %s", lb->base, text);
	lb->report (lb->ctx, error, msg);
}

static long post (BarLb_t *lb, const char *body) {
	buf_t url = {0}, auth = {0};
	bufAdd (&url, lb->base);
	bufAdd (&url, "/1/submit-listens");
	bufAdd (&auth, "Token ");
	bufAdd (&auth, lb->token);
	char * const u = bufTake (&url);
	char * const a = bufTake (&auth);
	long status = 0;
	if (u != NULL && a != NULL) {
		status = lb->post (lb->ctx, u, a, body);
	}
	if (a != NULL) {
		memset (a, 0, strlen (a));
	}
	free (u);
	free (a);
	lb->lastStatus = status;
	return status;
}

static bool retryable (long status) {
	return status == 0 || status == 401 || status == 403 || status == 408 ||
			status == 429 || status >= 500;
}

/* queue file: one listen ({"listened_at":..,"track_metadata":..}) per line */
static size_t queueRead (const BarLb_t *lb, char ***linesOut) {
	*linesOut = NULL;
	FILE * const f = fopen (lb->queuePath, "rb");
	if (f == NULL) {
		return 0;
	}
	char **lines = NULL;
	size_t n = 0, cap = 0;
	char *line = malloc (LINE_MAX_BYTES);
	while (line != NULL && fgets (line, LINE_MAX_BYTES, f) != NULL) {
		size_t len = strlen (line);
		while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
			line[--len] = '\0';
		}
		if (len == 0 || line[0] != '{') {
			continue;
		}
		if (n == cap) {
			cap = cap ? cap * 2 : 64;
			char ** const l2 = realloc (lines, cap * sizeof (*lines));
			if (l2 == NULL) {
				break;
			}
			lines = l2;
		}
		if ((lines[n] = dupStr (line)) != NULL) {
			n++;
		}
	}
	free (line);
	fclose (f);
	*linesOut = lines;
	return n;
}

static void linesFree (char **lines, size_t n) {
	for (size_t i = 0; i < n; i++) {
		free (lines[i]);
	}
	free (lines);
}

/* keep the newest BAR_LB_QUEUE_MAX of lines[from..n) */
static bool queueWrite (BarLb_t *lb, char **lines, size_t from, size_t n) {
	if (n - from > BAR_LB_QUEUE_MAX) {
		from = n - BAR_LB_QUEUE_MAX;
	}
	if (from >= n) {
		remove (lb->queuePath);
		lb->queued = 0;
		return true;
	}
	buf_t tmp = {0};
	bufAdd (&tmp, lb->queuePath);
	bufAdd (&tmp, ".tmp");
	char * const tmpPath = bufTake (&tmp);
	if (tmpPath == NULL) {
		return false;
	}
	FILE * const f = fopen (tmpPath, "wb");
	if (f == NULL) {
		free (tmpPath);
		return false;
	}
	bool ok = true;
	for (size_t i = from; i < n; i++) {
		ok = ok && fputs (lines[i], f) >= 0 && fputc ('\n', f) != EOF;
	}
	ok = (fclose (f) == 0) && ok;
#ifdef _WIN32
	if (ok) {
		remove (lb->queuePath);
	}
#endif
	ok = ok && rename (tmpPath, lb->queuePath) == 0;
	if (!ok) {
		remove (tmpPath);
	} else {
		lb->queued = n - from;
	}
	free (tmpPath);
	return ok;
}

static void queueAdd (BarLb_t *lb, const char *listen) {
	char **lines;
	size_t n = queueRead (lb, &lines);
	char ** const l2 = realloc (lines, (n + 1) * sizeof (*lines));
	if (l2 == NULL) {
		linesFree (lines, n);
		return;
	}
	lines = l2;
	if ((lines[n] = dupStr (listen)) != NULL) {
		n++;
	}
	if (!queueWrite (lb, lines, 0, n)) {
		report (lb, true, "could not write the listen queue file");
	}
	linesFree (lines, n);
}

static void backOff (BarLb_t *lb, time_t now) {
	lb->backoff = lb->backoff ? lb->backoff * 2 : BACKOFF_MIN;
	if (lb->backoff > BACKOFF_MAX) {
		lb->backoff = BACKOFF_MAX;
	}
	lb->nextRetry = now + lb->backoff;
}

static void statusMessage (BarLb_t *lb, long status, const char *what) {
	char text[256];
	if (status == 401 || status == 403) {
		snprintf (text, sizeof (text), "%s; the token was refused (HTTP %ld), "
				"%lu listen(s) waiting", what, status,
				(unsigned long) lb->queued);
	} else if (status == 0) {
		snprintf (text, sizeof (text), "%s; no answer, %lu listen(s) waiting",
				what, (unsigned long) lb->queued);
	} else {
		snprintf (text, sizeof (text), "%s (HTTP %ld), %lu listen(s) waiting",
				what, status, (unsigned long) lb->queued);
	}
	report (lb, true, text);
}

bool BarLbInit (BarLb_t *lb, const char *url, const char *token,
		const char *queuePath, const char *client, const char *clientVersion,
		BarLbPostFn postFn, BarLbReportFn reportFn, void *ctx) {
	memset (lb, 0, sizeof (*lb));
	if (empty (token) || postFn == NULL) {
		return false;
	}
	lb->base = BarLbResolveUrl (url);
	lb->token = dupStr (token);
	lb->queuePath = empty (queuePath) ? NULL : dupStr (queuePath);
	lb->client = dupStr (empty (client) ? "pianobar" : client);
	lb->clientVersion = dupStr (empty (clientVersion) ? "" : clientVersion);
	lb->post = postFn;
	lb->report = reportFn;
	lb->ctx = ctx;
	if (lb->base == NULL || lb->token == NULL || lb->client == NULL ||
			lb->clientVersion == NULL) {
		BarLbDestroy (lb);
		return false;
	}
	if (lb->queuePath != NULL) {
		char **lines;
		lb->queued = queueRead (lb, &lines);
		linesFree (lines, lb->queued);
	}
	/* retry at the first tick */
	lb->nextRetry = 0;
	return true;
}

bool BarLbEnabled (const BarLb_t *lb) {
	return lb->token != NULL;
}

void BarLbDestroy (BarLb_t *lb) {
	if (lb->token != NULL) {
		memset (lb->token, 0, strlen (lb->token));
	}
	free (lb->base);
	free (lb->token);
	free (lb->queuePath);
	free (lb->client);
	free (lb->clientVersion);
	free (lb->current);
	memset (lb, 0, sizeof (*lb));
}

void BarLbSongStart (BarLb_t *lb, const char *artist, const char *title,
		const char *album, const char *artUrl, const char *station,
		unsigned int lengthS, long long startedAt) {
	if (!BarLbEnabled (lb)) {
		return;
	}
	free (lb->current);
	lb->current = NULL;
	lb->active = false;
	/* songs only: Pandora's non-song items carry no artist and title */
	if (empty (artist) || empty (title)) {
		return;
	}
	lb->current = BarLbTrackMetadata (artist, title, album, artUrl, station,
			lengthS, lb->client, lb->clientVersion);
	if (lb->current == NULL) {
		return;
	}
	lb->startedAt = startedAt;
	lb->length = lengthS;
	lb->active = true;
	lb->submitted = false;

	buf_t b = {0};
	bufAdd (&b, "{\"listen_type\":\"playing_now\",\"payload\":"
			"[{\"track_metadata\":");
	bufAdd (&b, lb->current);
	bufAdd (&b, "}]}");
	char * const body = bufTake (&b);
	if (body != NULL) {
		const long status = post (lb, body);
		if (status >= 200 && status <= 299) {
			lb->nowPlayingFailed = false;
		} else if (!lb->nowPlayingFailed || status == 401 || status == 403) {
			/* not queued: now playing is only meaningful now */
			char text[128];
			if (status == 401 || status == 403) {
				snprintf (text, sizeof (text), "now playing: the token was "
						"refused (HTTP %ld)", status);
			} else if (status == 0) {
				snprintf (text, sizeof (text), "now playing not sent: no "
						"answer");
			} else {
				snprintf (text, sizeof (text), "now playing not sent (HTTP "
						"%ld)", status);
			}
			report (lb, true, text);
			lb->nowPlayingFailed = true;
		}
	}
	free (body);
}

void BarLbProgress (BarLb_t *lb, unsigned int lengthS, unsigned int playedS) {
	if (!BarLbEnabled (lb) || !lb->active || lb->submitted) {
		return;
	}
	const unsigned int len = lb->length ? lb->length : lengthS;
	if (!BarLbCounts (len, playedS)) {
		return;
	}
	lb->submitted = true;

	char head[64];
	snprintf (head, sizeof (head), "{\"listened_at\":%lld,\"track_metadata\":",
			lb->startedAt);
	buf_t l = {0};
	bufAdd (&l, head);
	bufAdd (&l, lb->current);
	bufAdd (&l, "}");
	char * const listen = bufTake (&l);
	if (listen == NULL) {
		return;
	}
	buf_t b = {0};
	bufAdd (&b, "{\"listen_type\":\"single\",\"payload\":[");
	bufAdd (&b, listen);
	bufAdd (&b, "]}");
	char * const body = bufTake (&b);
	const long status = body != NULL ? post (lb, body) : 0;
	free (body);
	if (status >= 200 && status <= 299) {
		lb->backoff = 0;
		if (lb->queued > 0) {
			BarLbFlush (lb);
		}
	} else if (retryable (status) && lb->queuePath != NULL) {
		queueAdd (lb, listen);
		if (lb->nextRetry <= time (NULL)) {
			backOff (lb, time (NULL));
		}
		statusMessage (lb, status, "listen queued");
	} else {
		statusMessage (lb, status, "listen not accepted, dropped");
	}
	free (listen);
}

void BarLbSongEnd (BarLb_t *lb) {
	lb->active = false;
}

/* send lines[from..to) as one import; returns the HTTP status */
static long sendBatch (BarLb_t *lb, char **lines, size_t from, size_t to) {
	buf_t b = {0};
	bufAdd (&b, "{\"listen_type\":\"import\",\"payload\":[");
	for (size_t i = from; i < to; i++) {
		bufAdd (&b, i == from ? "" : ",");
		bufAdd (&b, lines[i]);
	}
	bufAdd (&b, "]}");
	char * const body = bufTake (&b);
	const long status = body != NULL ? post (lb, body) : 0;
	free (body);
	return status;
}

void BarLbFlush (BarLb_t *lb) {
	if (!BarLbEnabled (lb) || lb->queuePath == NULL) {
		return;
	}
	char **lines;
	const size_t n = queueRead (lb, &lines);
	lb->queued = n;
	size_t done = 0, sent = 0, dropped = 0;
	long status = 200;
	while (done < n) {
		const size_t to = n - done > BAR_LB_BATCH ? done + BAR_LB_BATCH : n;
		status = sendBatch (lb, lines, done, to);
		if (status >= 200 && status <= 299) {
			sent += to - done;
			done = to;
		} else if (status == 400) {
			/* one bad listen must not block the rest: one at a time */
			for (size_t i = done; i < to; i++) {
				status = sendBatch (lb, lines, i, i + 1);
				if (status >= 200 && status <= 299) {
					sent++;
				} else if (status == 400) {
					dropped++;
				} else {
					break;
				}
				done = i + 1;
			}
			if (done < to) {
				break;
			}
			status = 200;
		} else {
			break;
		}
	}
	if (done > 0 && !queueWrite (lb, lines, done, n)) {
		report (lb, true, "could not rewrite the listen queue file");
	}
	linesFree (lines, n);
	const time_t now = time (NULL);
	if (done < n) {
		lb->queued = n - done;
		backOff (lb, now);
		statusMessage (lb, status, "queued listens not sent yet");
	} else {
		lb->queued = 0;
		lb->backoff = 0;
		lb->nextRetry = 0;
	}
	char text[128];
	if (sent > 0) {
		snprintf (text, sizeof (text), "sent %lu queued listen(s), %lu still "
				"waiting", (unsigned long) sent, (unsigned long) lb->queued);
		report (lb, false, text);
	}
	if (dropped > 0) {
		snprintf (text, sizeof (text), "dropped %lu queued listen(s) the "
				"server refused, %lu still waiting", (unsigned long) dropped,
				(unsigned long) lb->queued);
		report (lb, true, text);
	}
}

void BarLbTick (BarLb_t *lb, time_t now) {
	if (!BarLbEnabled (lb) || lb->queued == 0 || now < lb->nextRetry) {
		return;
	}
	BarLbFlush (lb);
}
