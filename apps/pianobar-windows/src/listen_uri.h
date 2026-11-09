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

/* listen:// links (melodica-scrobble docs/LISTEN-URI.md): a C port of the
 * reference parser src/listen-uri.js. It accepts and rejects exactly what
 * tests/listen-uri.test.mjs pins (see test/listen_uri_test.c), with one
 * difference in values, not in acceptance: decoded artist and genre names are
 * not NFC-normalised (only the three canonical singletons that map to ASCII,
 * U+212A, U+037E and U+1FEF, are, so the ASCII-only rules decide alike). */

#pragma once

#include <stdbool.h>

#define BAR_LISTEN_HTTPS_BASE "https://spacegho.st/listen/"

typedef enum {
	BAR_LISTEN_ARTIST = 0,
	BAR_LISTEN_GENRE,
	BAR_LISTEN_STATION,
	BAR_LISTEN_TRACK,
	BAR_LISTEN_MAP,
	BAR_LISTEN_USER,
	BAR_LISTEN_LISTENS,
	BAR_LISTEN_LEADERBOARD,
	BAR_LISTEN_COUNT
} BarListenTarget_t;

typedef struct {
	BarListenTarget_t target;
	/* field[0]: name, station, track, land or username; field[1]: province.
	 * NULL when absent. */
	char *field[2];
	long t; /* track start in seconds, -1 when absent */
	/* the three forms, re-encoded */
	char *uri, *web, *https;
} BarListenUri_t;

/* Returns true and fills out (free with BarListenUriFree) for a valid link. */
bool BarListenUriParse (const char *input, BarListenUri_t *out);
void BarListenUriFree (BarListenUri_t *);
const char *BarListenTargetName (BarListenTarget_t);
/* routeOf(): the path on spacegho.st this target opens; malloc'd. */
char *BarListenUriRoute (const BarListenUri_t *);
/* listenUri(): build from a target name and fields; false when it would not
 * parse back. */
bool BarListenUriBuild (const char *target, const char *f0, const char *f1,
		long t, BarListenUri_t *out);
