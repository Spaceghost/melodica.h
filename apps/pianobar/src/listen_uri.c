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

#include "listen_uri.h"

#define MAX_INPUT 1024
#define MAX_TEXT 200

typedef enum { SEG_TEXT, SEG_SLUG, SEG_USERNAME, SEG_STATION, SEG_TRACK } seg_t;

static const struct {
	const char *name;
	seg_t segs[2];
	int required, max;
	bool queryT;
} targets[BAR_LISTEN_COUNT] = {
	[BAR_LISTEN_ARTIST] = { "artist", { SEG_TEXT }, 1, 1, false },
	[BAR_LISTEN_GENRE] = { "genre", { SEG_TEXT }, 1, 1, false },
	[BAR_LISTEN_STATION] = { "station", { SEG_STATION }, 1, 1, false },
	[BAR_LISTEN_TRACK] = { "track", { SEG_TRACK }, 1, 1, true },
	[BAR_LISTEN_MAP] = { "map", { SEG_SLUG, SEG_SLUG }, 1, 2, false },
	[BAR_LISTEN_USER] = { "user", { SEG_USERNAME }, 1, 1, false },
	[BAR_LISTEN_LISTENS] = { "listens", { SEG_TEXT }, 0, 0, false },
	[BAR_LISTEN_LEADERBOARD] = { "leaderboard", { SEG_TEXT }, 0, 0, false },
};

const char *BarListenTargetName (BarListenTarget_t t) {
	return t < BAR_LISTEN_COUNT ? targets[t].name : "";
}

static char *dupN (const char *s, size_t n) {
	char * const d = malloc (n + 1);
	if (d != NULL) {
		memcpy (d, s, n);
		d[n] = '\0';
	}
	return d;
}

/* JavaScript String length: UTF-16 code units of a UTF-8 string */
static size_t len16 (const char *s, size_t n) {
	size_t units = 0;
	for (size_t i = 0; i < n; i++) {
		const unsigned char c = (unsigned char) s[i];
		if ((c & 0xc0) != 0x80) {
			units += c >= 0xf0 ? 2 : 1;
		}
	}
	return units;
}

static bool isAlnum (char c) {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9');
}

static bool isLowerAlnum (char c) {
	return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}

static int hexVal (char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/* decode one UTF-8 code point strictly (RFC 3629); returns its length or 0 */
static size_t utf8Next (const unsigned char *s, size_t n, unsigned long *cp) {
	if (n == 0) return 0;
	const unsigned char c = s[0];
	size_t len;
	unsigned long v, min;
	if (c < 0x80) { *cp = c; return 1; }
	else if (c >= 0xc2 && c <= 0xdf) { len = 2; v = c & 0x1f; min = 0x80; }
	else if (c >= 0xe0 && c <= 0xef) { len = 3; v = c & 0x0f; min = 0x800; }
	else if (c >= 0xf0 && c <= 0xf4) { len = 4; v = c & 0x07; min = 0x10000; }
	else return 0;
	if (n < len) return 0;
	for (size_t i = 1; i < len; i++) {
		if ((s[i] & 0xc0) != 0x80) return 0;
		v = (v << 6) | (s[i] & 0x3f);
	}
	if (v < min || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return 0;
	*cp = v;
	return len;
}

/* String.prototype.trim()'s white space and line terminators */
static bool jsSpace (unsigned long c) {
	return (c >= 0x09 && c <= 0x0d) || c == 0x20 || c == 0xa0 ||
			c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 ||
			c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 ||
			c == 0xfeff;
}

/* decodeSeg(): NULL when rejected; malloc'd otherwise */
static char *decodeSeg (const char *raw, size_t n) {
	static const char allowed[] = "-._~%!$&'()*+,;=:@";
	for (size_t i = 0; i < n; i++) {
		if (!isAlnum (raw[i]) && (raw[i] == '\0' ||
				strchr (allowed, raw[i]) == NULL)) {
			return NULL;
		}
	}
	/* decodeURIComponent */
	char * const s = malloc (n + 1);
	if (s == NULL) return NULL;
	size_t len = 0;
	for (size_t i = 0; i < n; i++) {
		if (raw[i] == '%') {
			if (i + 2 >= n || hexVal (raw[i+1]) < 0 || hexVal (raw[i+2]) < 0) {
				free (s);
				return NULL;
			}
			s[len++] = (char) (hexVal (raw[i+1]) * 16 + hexVal (raw[i+2]));
			i += 2;
		} else {
			s[len++] = raw[i];
		}
	}
	s[len] = '\0';
	if (len == 0) {
		free (s);
		return NULL;
	}
	/* valid UTF-8, no controls, / or \, at most 200 UTF-16 units, no
	 * surrounding white space */
	unsigned long first = 0, last = 0;
	size_t units = 0;
	for (size_t i = 0; i < len; ) {
		unsigned long cp;
		const size_t k = utf8Next ((const unsigned char *) s + i, len - i, &cp);
		if (k == 0 || cp <= 0x1f || cp == 0x7f || cp == '/' || cp == '\\') {
			free (s);
			return NULL;
		}
		if (i == 0) first = cp;
		last = cp;
		units += cp >= 0x10000 ? 2 : 1;
		i += k;
	}
	if (units > MAX_TEXT || jsSpace (first) || jsSpace (last) ||
			strcmp (s, ".") == 0 || strcmp (s, "..") == 0) {
		free (s);
		return NULL;
	}
	/* NFC, limited to the canonical singletons that become ASCII */
	char *o = s;
	for (size_t i = 0; i < len; ) {
		const unsigned char *p = (const unsigned char *) s + i;
		if (len - i >= 3 && p[0] == 0xe2 && p[1] == 0x84 && p[2] == 0xaa) {
			*o++ = 'K'; i += 3; /* U+212A KELVIN SIGN */
		} else if (len - i >= 2 && p[0] == 0xcd && p[1] == 0xbe) {
			*o++ = ';'; i += 2; /* U+037E GREEK QUESTION MARK */
		} else if (len - i >= 3 && p[0] == 0xe1 && p[1] == 0xbf && p[2] == 0xaf) {
			*o++ = '`'; i += 3; /* U+1FEF GREEK VARIA */
		} else {
			*o++ = s[i++];
		}
	}
	*o = '\0';
	return s;
}

static bool checkSeg (seg_t rule, const char *v) {
	const size_t n = strlen (v);
	switch (rule) {
		case SEG_TEXT:
			return true;
		case SEG_SLUG:
			/* ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$ */
			if (n < 1 || n > 64 || !isLowerAlnum (v[0]) ||
					!isLowerAlnum (v[n-1])) return false;
			for (size_t i = 0; i < n; i++) {
				if (!isLowerAlnum (v[i]) && v[i] != '-') return false;
			}
			return true;
		case SEG_USERNAME:
			/* ^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$ */
			if (n < 3 || n > 40 || !isLowerAlnum (v[0]) ||
					!isLowerAlnum (v[n-1])) return false;
			for (size_t i = 0; i < n; i++) {
				if (!isLowerAlnum (v[i]) && v[i] != '-' && v[i] != '_') return false;
			}
			return true;
		case SEG_STATION:
		case SEG_TRACK:
			/* [A-Za-z0-9]{1,64} (64 hex digits are a subset) */
			if (n < 1 || n > 64) return false;
			for (size_t i = 0; i < n; i++) {
				if (!isAlnum (v[i])) return false;
			}
			return true;
	}
	return false;
}

static bool prefixCase (const char *s, const char *prefix) {
	for (; *prefix; s++, prefix++) {
		char c = *s;
		if (c >= 'A' && c <= 'Z') c = (char) (c - 'A' + 'a');
		if (c != *prefix) return false;
	}
	return true;
}

/* encodeURIComponent */
static void encodeComponent (char *out, const char *s) {
	static const char keep[] = "-_.!~*'()";
	char *o = out;
	for (const unsigned char *p = (const unsigned char *) s; *p; p++) {
		if (isAlnum ((char) *p) || (*p != '\0' && strchr (keep, *p) != NULL)) {
			*o++ = (char) *p;
		} else {
			o += sprintf (o, "%%%02X", *p);
		}
	}
	*o = '\0';
}

static bool forms (BarListenUri_t *u) {
	size_t need = strlen (targets[u->target].name) + 32;
	for (int i = 0; i < 2; i++) {
		if (u->field[i] != NULL) need += strlen (u->field[i]) * 3 + 1;
	}
	char * const path = malloc (need);
	if (path == NULL) return false;
	char *o = path;
	o += sprintf (o, "%s", targets[u->target].name);
	for (int i = 0; i < 2; i++) {
		if (u->field[i] != NULL) {
			*o++ = '/';
			encodeComponent (o, u->field[i]);
			o += strlen (o);
		}
	}
	if (u->t >= 0) {
		sprintf (o, "?t=%ld", u->t);
	}
	const size_t pl = strlen (path);
	u->uri = malloc (pl + sizeof ("listen://"));
	u->web = malloc (pl + sizeof ("web+listen://"));
	u->https = malloc (pl + sizeof (BAR_LISTEN_HTTPS_BASE));
	if (u->uri == NULL || u->web == NULL || u->https == NULL) {
		free (path);
		return false;
	}
	sprintf (u->uri, "listen://%s", path);
	sprintf (u->web, "web+listen://%s", path);
	sprintf (u->https, "%s%s", BAR_LISTEN_HTTPS_BASE, path);
	free (path);
	return true;
}

void BarListenUriFree (BarListenUri_t *u) {
	if (u == NULL) return;
	free (u->field[0]);
	free (u->field[1]);
	free (u->uri);
	free (u->web);
	free (u->https);
	memset (u, 0, sizeof (*u));
	u->t = -1;
}

bool BarListenUriParse (const char *input, BarListenUri_t *out) {
	memset (out, 0, sizeof (*out));
	out->t = -1;
	if (input == NULL) return false;
	const size_t inLen = strlen (input);
	if (len16 (input, inLen) > MAX_INPUT) return false;

	const char *rest;
	if (prefixCase (input, "listen://") || prefixCase (input, "web+listen://")) {
		rest = input + (prefixCase (input, "listen://") ? 9 : 13);
		/* the reference's (.*)$ does not match line terminators */
		if (strpbrk (rest, "\n\r") != NULL || strstr (rest, "\xe2\x80\xa8") != NULL ||
				strstr (rest, "\xe2\x80\xa9") != NULL) {
			return false;
		}
	} else if (prefixCase (input, BAR_LISTEN_HTTPS_BASE)) {
		rest = input + strlen (BAR_LISTEN_HTTPS_BASE);
	} else {
		return false;
	}
	if (strchr (rest, '#') != NULL) return false;

	const char * const q = strchr (rest, '?');
	size_t pathLen = q != NULL ? (size_t) (q - rest) : strlen (rest);
	const char * const query = q != NULL ? q + 1 : "";
	if (pathLen > 0 && rest[pathLen-1] == '/') pathLen--;

	/* split the path on '/' */
	const char *parts[8];
	size_t partLen[8];
	size_t nparts = 0;
	const char *p = rest, * const end = rest + pathLen;
	while (1) {
		const char *slash = memchr (p, '/', (size_t) (end - p));
		const char *segEnd = slash != NULL ? slash : end;
		if (nparts == 8) return false;
		parts[nparts] = p;
		partLen[nparts] = (size_t) (segEnd - p);
		nparts++;
		if (slash == NULL) break;
		p = slash + 1;
	}

	/* target, lower-cased as JavaScript does (U+212A becomes k) */
	char target[16];
	size_t tl = 0;
	for (size_t i = 0; i < partLen[0]; i++) {
		const unsigned char *c = (const unsigned char *) parts[0] + i;
		char ch;
		if (partLen[0] - i >= 3 && c[0] == 0xe2 && c[1] == 0x84 && c[2] == 0xaa) {
			ch = 'k';
			i += 2;
		} else if (*c >= 'A' && *c <= 'Z') {
			ch = (char) (*c - 'A' + 'a');
		} else if (*c >= 0x80) {
			return false; /* no other non-ASCII letter lowers to ASCII */
		} else {
			ch = (char) *c;
		}
		if (tl + 1 >= sizeof (target)) return false;
		target[tl++] = ch;
	}
	target[tl] = '\0';
	int ti = -1;
	for (int i = 0; i < BAR_LISTEN_COUNT; i++) {
		if (strcmp (target, targets[i].name) == 0) ti = i;
	}
	if (ti < 0) return false;
	out->target = (BarListenTarget_t) ti;
	const int nseg = (int) nparts - 1;
	if (nseg < targets[ti].required || nseg > targets[ti].max) return false;

	for (int i = 0; i < nseg; i++) {
		char * const v = decodeSeg (parts[i+1], partLen[i+1]);
		if (v == NULL || !checkSeg (targets[ti].segs[i], v)) {
			free (v);
			BarListenUriFree (out);
			return false;
		}
		out->field[i] = v;
	}

	if (query[0] != '\0') {
		const char *pair = query;
		while (1) {
			const char *amp = strchr (pair, '&');
			const size_t pl = amp != NULL ? (size_t) (amp - pair) : strlen (pair);
			/* [k, v = ''] = pair.split('=') */
			const char *eq = memchr (pair, '=', pl);
			const size_t kl = eq != NULL ? (size_t) (eq - pair) : pl;
			const char *v = eq != NULL ? eq + 1 : pair + pl;
			const char *veq = eq != NULL ? memchr (v, '=', pl - kl - 1) : NULL;
			const size_t vl = eq == NULL ? 0 : (veq != NULL ? (size_t) (veq - v) : pl - kl - 1);
			if (!(targets[ti].queryT && kl == 1 && pair[0] == 't') || out->t >= 0) {
				BarListenUriFree (out);
				return false;
			}
			/* ^\d{1,5}$, at most 86400 */
			bool ok = vl >= 1 && vl <= 5;
			long t = 0;
			for (size_t i = 0; ok && i < vl; i++) {
				ok = v[i] >= '0' && v[i] <= '9';
				t = t * 10 + (v[i] - '0');
			}
			if (!ok || t > 86400) {
				BarListenUriFree (out);
				return false;
			}
			out->t = t;
			if (amp == NULL) break;
			pair = amp + 1;
		}
	}

	if (!forms (out)) {
		BarListenUriFree (out);
		return false;
	}
	return true;
}

bool BarListenUriBuild (const char *target, const char *f0, const char *f1,
		long t, BarListenUri_t *out) {
	memset (out, 0, sizeof (*out));
	out->t = -1;
	int ti = -1;
	for (int i = 0; target != NULL && i < BAR_LISTEN_COUNT; i++) {
		if (strcmp (target, targets[i].name) == 0) ti = i;
	}
	if (ti < 0) return false;
	BarListenUri_t tmp;
	memset (&tmp, 0, sizeof (tmp));
	tmp.target = (BarListenTarget_t) ti;
	tmp.t = t;
	tmp.field[0] = f0 != NULL ? dupN (f0, strlen (f0)) : NULL;
	tmp.field[1] = f1 != NULL ? dupN (f1, strlen (f1)) : NULL;
	const bool built = forms (&tmp);
	const bool ok = built && BarListenUriParse (tmp.uri, out);
	BarListenUriFree (&tmp);
	return ok;
}

char *BarListenUriRoute (const BarListenUri_t *u) {
	const char *f0 = u->field[0] != NULL ? u->field[0] : "";
	const char *f1 = u->field[1];
	char * const e0 = malloc (strlen (f0) * 3 + 1);
	char * const e1 = malloc ((f1 != NULL ? strlen (f1) : 0) * 3 + 1);
	char * const r = malloc (strlen (f0) * 3 + (f1 != NULL ? strlen (f1) * 3 : 0) + 64);
	if (e0 == NULL || e1 == NULL || r == NULL) {
		free (e0); free (e1); free (r);
		return NULL;
	}
	encodeComponent (e0, f0);
	encodeComponent (e1, f1 != NULL ? f1 : "");
	switch (u->target) {
		case BAR_LISTEN_ARTIST:
		case BAR_LISTEN_GENRE:
			sprintf (r, "/melodica/app/?seed=%s:%s", targets[u->target].name, e0);
			break;
		case BAR_LISTEN_STATION:
			sprintf (r, "/melodica/app/?station=%s", e0);
			break;
		case BAR_LISTEN_TRACK:
			if (u->t >= 0) sprintf (r, "/melodica/listens/?track=%s&t=%ld", e0, u->t);
			else sprintf (r, "/melodica/listens/?track=%s", e0);
			break;
		case BAR_LISTEN_MAP:
			if (f1 != NULL && f1[0] != '\0') sprintf (r, "/melodica/map/?land=%s&province=%s", e0, e1);
			else sprintf (r, "/melodica/map/?land=%s", e0);
			break;
		case BAR_LISTEN_USER:
			sprintf (r, "/melodica/leaderboard/?user=%s", e0);
			break;
		case BAR_LISTEN_LISTENS:
			strcpy (r, "/melodica/listens/");
			break;
		case BAR_LISTEN_LEADERBOARD:
			strcpy (r, "/melodica/leaderboard/");
			break;
		default:
			strcpy (r, "/melodica/");
	}
	free (e0);
	free (e1);
	return r;
}
