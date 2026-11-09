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

/* listen:// links in pianobar (docs: contrib/pianobar.1, LISTEN LINKS).
 * A link never starts playback by itself: artist, genre and station links
 * select a station and ask before it plays; every other target opens its
 * page on spacegho.st in the browser. */

#pragma once

#include "listen_uri.h"
#include "main.h"

/* Handle the command line link before login. Returns -1 when pianobar should
 * go on (out then holds a station-like link to resolve after login), or the
 * exit status (0 after opening the browser, 1 for an unsupported link). */
int BarListenEarly (const char *arg, BarListenUri_t *out);

/* After the station list is loaded: find or create the link's station and ask
 * the user to start it. Returns the station to play, or NULL to fall back to
 * the normal station selection. */
PianoStation_t *BarListenResolve (BarApp_t *app, const BarListenUri_t *link);
