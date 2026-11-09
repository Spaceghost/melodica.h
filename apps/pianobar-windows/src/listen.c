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

#include "config.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include <windows.h>
#include <shellapi.h>

#ifdef _MSC_VER
#pragma comment(lib, "shell32.lib")
#endif
#define strncasecmp _strnicmp

#include "listen.h"
#include "ui.h"
#include "ui_readline.h"

/* Started by the listen:// handler, pianobar has a console of its own that
 * closes with it: keep a message readable until Enter. */
static void BarListenPauseIfOwnConsole (void) {
	DWORD ids[2];
	if (GetConsoleProcessList (ids, 2) == 1 &&
			GetFileType (GetStdHandle (STD_INPUT_HANDLE)) == FILE_TYPE_CHAR) {
		fprintf (stderr, "Press Enter to close.\n");
		(void) getchar ();
	}
}

/* open url in the default browser */
static bool BarListenOpenBrowser (const char *url) {
	return (INT_PTR) ShellExecuteA (NULL, "open", url, NULL, NULL,
			SW_SHOWNORMAL) > 32;
}

int BarListenEarly (const char *arg, BarListenUri_t *out) {
	if (!BarListenUriParse (arg, out)) {
		fprintf (stderr, "That link isn't supported.\n");
		BarListenPauseIfOwnConsole ();
		return 1;
	}
	switch (out->target) {
		case BAR_LISTEN_ARTIST:
		case BAR_LISTEN_GENRE:
		case BAR_LISTEN_STATION:
			return -1;
		default:
			break;
	}
	/* pages, not stations: spacegho.st shows them */
	char * const route = BarListenUriRoute (out);
	char * const url = route != NULL ? malloc (strlen (route) + 32) : NULL;
	int ret = 1;
	if (url != NULL) {
		sprintf (url, "https://spacegho.st%s", route);
		printf ("Opening %s\n", url);
		fflush (stdout);
		ret = BarListenOpenBrowser (url) ? 0 : 1;
		if (ret != 0) {
			fprintf (stderr, "Could not open a browser; the link is %s\n", url);
			BarListenPauseIfOwnConsole ();
		}
	}
	free (route);
	free (url);
	BarListenUriFree (out);
	return ret;
}

/* named like the seed: "<name>" or "<name> Radio", ignoring case */
static bool BarListenNameMatches (const char *candidate, const char *name) {
	const size_t n = strlen (name);
	return candidate != NULL && (strcasecmp (candidate, name) == 0 ||
			(strncasecmp (candidate, name, n) == 0 &&
			strcasecmp (candidate + n, " Radio") == 0));
}

static PianoStation_t *BarListenFindByName (PianoStation_t *stations,
		const char *name) {
	PianoStation_t *s = stations;
	PianoListForeachP (s) {
		if (BarListenNameMatches (s->name, name)) {
			return s;
		}
	}
	return NULL;
}

static bool BarListenConfirm (BarApp_t *app, const char *question,
		const char *name) {
	BarUiMsg (&app->settings, MSG_QUESTION, question, name);
	return BarReadlineYesNo (true, app->rl);
}

static PianoStation_t *BarListenLast (PianoStation_t *s) {
	PianoStation_t *last = NULL;
	PianoListForeachP (s) {
		last = s;
	}
	return last;
}

/* create a station from a musicId; returns the new station or NULL */
static PianoStation_t *BarListenCreate (BarApp_t *app, char *musicId,
		const char *name) {
	PianoReturn_t pRet;
	PianoRequestDataCreateStation_t reqData;
	reqData.token = musicId;
	reqData.type = PIANO_MUSICTYPE_INVALID;
	BarUiMsg (&app->settings, MSG_INFO, "Creating station \"%s\"... ", name);
	if (!BarUiPianoCall (app, PIANO_REQUEST_CREATE_STATION, &reqData, &pRet)) {
		return NULL;
	}
	BarUiStartEventCmd (&app->settings, "stationcreate", NULL, NULL,
			&app->player, app->ph.stations, pRet);
	return BarListenLast (app->ph.stations);
}

static PianoStation_t *BarListenArtist (BarApp_t *app, const char *name) {
	PianoStation_t * const have = BarListenFindByName (app->ph.stations, name);
	if (have != NULL) {
		return BarListenConfirm (app, "Start station \"%s\"? [Yn] ", have->name) ?
				have : NULL;
	}
	PianoReturn_t pRet;
	PianoRequestDataSearch_t reqData;
	memset (&reqData, 0, sizeof (reqData));
	reqData.searchStr = (char *) name;
	BarUiMsg (&app->settings, MSG_INFO, "Searching for \"%s\"... ", name);
	if (!BarUiPianoCall (app, PIANO_REQUEST_SEARCH, &reqData, &pRet)) {
		return NULL;
	}
	PianoArtist_t *artist = NULL, *a = reqData.searchResult.artists;
	PianoListForeachP (a) {
		if (a->name != NULL && strcasecmp (a->name, name) == 0) {
			artist = a;
			break;
		}
	}
	if (artist == NULL) {
		artist = reqData.searchResult.artists;
	}
	PianoStation_t *ret = NULL;
	if (artist == NULL || artist->musicId == NULL) {
		BarUiMsg (&app->settings, MSG_ERR, "No artist \"%s\" on Pandora.\n",
				name);
	} else if (BarListenConfirm (app, "Create and start a station for "
			"\"%s\"? [Yn] ", artist->name)) {
		ret = BarListenCreate (app, artist->musicId, artist->name);
	}
	PianoDestroySearchResult (&reqData.searchResult);
	return ret;
}

static PianoStation_t *BarListenGenre (BarApp_t *app, const char *name) {
	PianoStation_t * const have = BarListenFindByName (app->ph.stations, name);
	if (have != NULL) {
		return BarListenConfirm (app, "Start station \"%s\"? [Yn] ", have->name) ?
				have : NULL;
	}
	PianoReturn_t pRet;
	if (app->ph.genreStations == NULL) {
		BarUiMsg (&app->settings, MSG_INFO, "Receiving genre stations... ");
		if (!BarUiPianoCall (app, PIANO_REQUEST_GET_GENRE_STATIONS, NULL,
				&pRet)) {
			return NULL;
		}
	}
	PianoGenre_t *found = NULL;
	PianoGenreCategory_t *cat = app->ph.genreStations;
	PianoListForeachP (cat) {
		PianoGenre_t *g = cat->genres;
		PianoListForeachP (g) {
			if (found == NULL && BarListenNameMatches (g->name, name)) {
				found = g;
			}
		}
	}
	if (found == NULL || found->musicId == NULL) {
		BarUiMsg (&app->settings, MSG_ERR, "No genre station \"%s\" on "
				"Pandora.\n", name);
		return NULL;
	}
	if (!BarListenConfirm (app, "Add and start the genre station \"%s\"? [Yn] ",
			found->name)) {
		return NULL;
	}
	return BarListenCreate (app, found->musicId, found->name);
}

PianoStation_t *BarListenResolve (BarApp_t *app, const BarListenUri_t *link) {
	switch (link->target) {
		case BAR_LISTEN_STATION: {
			PianoStation_t * const s = PianoFindStationById (app->ph.stations,
					link->field[0]);
			if (s == NULL) {
				BarUiMsg (&app->settings, MSG_ERR, "Station %s is not in your "
						"station list.\n", link->field[0]);
				return NULL;
			}
			return BarListenConfirm (app, "Start station \"%s\"? [Yn] ",
					s->name) ? s : NULL;
		}
		case BAR_LISTEN_ARTIST:
			return BarListenArtist (app, link->field[0]);
		case BAR_LISTEN_GENRE:
			return BarListenGenre (app, link->field[0]);
		default:
			return NULL;
	}
}
