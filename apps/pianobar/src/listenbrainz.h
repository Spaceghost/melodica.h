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

/* ListenBrainz-compatible scrobbling (spacegho.st/scrobble by default).
 *
 * Transport-free: the caller supplies an HTTP POST function (libcurl on
 * Linux/macOS, WinHTTP on Windows). Listens that could not be delivered are
 * kept in a queue file, one JSON listen per line, and retried later as a
 * listen_type "import". The token is only ever handed to the transport; it is
 * never part of a message, the queue file or a request body. */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <time.h>

#define BAR_LB_DEFAULT_URL "https://spacegho.st/scrobble"
#define BAR_LB_LISTENBRAINZ_URL "https://api.listenbrainz.org"
#define BAR_LB_QUEUE_MAX 1000
#define BAR_LB_BATCH 100

/* POST body (application/json) to url with the given Authorization header
 * value ("Token ..."). Returns the HTTP status, or 0 if there was no answer. */
typedef long (*BarLbPostFn) (void *ctx, const char *url,
		const char *authorization, const char *body);
/* A message for the user; never contains the token. */
typedef void (*BarLbReportFn) (void *ctx, bool error, const char *msg);

typedef struct {
	char *base, *token, *queuePath;
	char *client, *clientVersion;
	BarLbPostFn post;
	BarLbReportFn report;
	void *ctx;
	/* the song playing now */
	char *current; /* serialized track_metadata */
	long long startedAt;
	unsigned int length;
	bool active, submitted;
	bool nowPlayingFailed; /* reported once until the next success */
	/* queue */
	size_t queued;
	time_t nextRetry;
	unsigned int backoff;
	long lastStatus;
} BarLb_t;

/* "spacegho.st" and "listenbrainz" are presets; anything else is used as is
 * (without trailing slashes). Returns a malloc'd string. */
char *BarLbResolveUrl (const char *url);
/* The standard rule: longer than 30 s, played half of it or four minutes. */
bool BarLbCounts (unsigned int lengthS, unsigned int playedS);

/* Enabled only when token is non-empty. Returns whether it is enabled. */
bool BarLbInit (BarLb_t *, const char *url, const char *token,
		const char *queuePath, const char *client, const char *clientVersion,
		BarLbPostFn, BarLbReportFn, void *ctx);
void BarLbDestroy (BarLb_t *);
bool BarLbEnabled (const BarLb_t *);

/* A song started: sends playing_now. Strings may be NULL. */
void BarLbSongStart (BarLb_t *, const char *artist, const char *title,
		const char *album, const char *artUrl, const char *station,
		unsigned int lengthS, long long startedAt);
/* Playback position: submits the listen once it counts. */
void BarLbProgress (BarLb_t *, unsigned int lengthS, unsigned int playedS);
/* The song is over (finished, skipped or stopped). */
void BarLbSongEnd (BarLb_t *);
/* Retry the queue when it is due (call often; cheap otherwise). */
void BarLbTick (BarLb_t *, time_t now);
/* Retry now, regardless of the back-off. */
void BarLbFlush (BarLb_t *);

/* exposed for tests */
char *BarLbTrackMetadata (const char *artist, const char *title,
		const char *album, const char *artUrl, const char *station,
		unsigned int lengthS, const char *client, const char *clientVersion);
