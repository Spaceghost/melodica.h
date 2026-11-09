/* A port of melodica-scrobble tests/listen-uri.test.mjs (same cases, same
 * expectations) for src/listen_uri.c. Build and run: make test.
 *
 *   listen_uri_test          run the cases
 *   listen_uri_test --lines  read one link per line on stdin and print its
 *                            listen:// form (or "null"), for differential
 *                            runs against the reference parser */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/listen_uri.h"

static int failures = 0;
#define CHECK(c, what) do { if (!(c)) { fprintf (stderr, "FAIL %s:%d: %s (%s)\n", \
		__FILE__, __LINE__, #c, what); failures++; } } while (0)

static const char *field (const BarListenUri_t *u, const char *key) {
	if (strcmp (key, "province") == 0) return u->field[1];
	return u->field[0];
}

static char *repeat (char c, size_t n, const char *prefix, const char *suffix) {
	char * const s = malloc (strlen (prefix) + n + strlen (suffix) + 1);
	strcpy (s, prefix);
	memset (s + strlen (prefix), c, n);
	strcpy (s + strlen (prefix) + n, suffix);
	return s;
}

static void parsesEveryTarget (void) {
	char * const track = repeat ('a', 64, "listen://track/", "?t=95");
	char * const a64 = repeat ('a', 64, "", "");
	const struct { const char *u, *target, *k1, *v1, *k2, *v2; long t; } cases[] = {
		{ "listen://artist/Modest%20Mouse", "artist", "name", "Modest Mouse", NULL, NULL, -1 },
		{ "web+listen://genre/thrash%20metal", "genre", "name", "thrash metal", NULL, NULL, -1 },
		{ "https://spacegho.st/listen/station/4123456789012345", "station", "station", "4123456789012345", NULL, NULL, -1 },
		{ track, "track", "track", a64, NULL, NULL, 95 },
		{ "listen://map/neon-plains/synthwave-reach", "map", "land", "neon-plains", "province", "synthwave-reach", -1 },
		{ "listen://map/neon-plains", "map", "land", "neon-plains", NULL, NULL, -1 },
		{ "listen://user/knewter", "user", "username", "knewter", NULL, NULL, -1 },
		{ "listen://listens", "listens", NULL, NULL, NULL, NULL, -1 },
		{ "LISTEN://Leaderboard/", "leaderboard", NULL, NULL, NULL, NULL, -1 },
		{ "listen://artist/Sigur%20R%C3%B3s", "artist", "name", "Sigur R\xc3\xb3s", NULL, NULL, -1 },
		{ "listen://artist/Cafe%CC%81", "artist", "name", "Caf\xc3\xa9", NULL, NULL, -1 },
		{ "web+listen://genre/%E1%84%80%E1%85%A1", "genre", "name", "\xea\xb0\x80", NULL, NULL, -1 },
		{ "https://spacegho.st/listen/artist/%E2%84%AB", "artist", "name", "\xc3\x85", NULL, NULL, -1 },
		{ "listen://artist/%CE%B1%CC%81", "artist", "name", "\xce\xac", NULL, NULL, -1 },
		{ "listen://artist/A%CC%81%CC%A7", "artist", "name", "\xc3\x81\xcc\xa7", NULL, NULL, -1 },
	};
	for (size_t i = 0; i < sizeof (cases) / sizeof (*cases); i++) {
		BarListenUri_t p, h, w;
		const bool ok = BarListenUriParse (cases[i].u, &p);
		CHECK (ok, cases[i].u);
		if (!ok) continue;
		CHECK (strcmp (BarListenTargetName (p.target), cases[i].target) == 0, cases[i].u);
		if (cases[i].k1) CHECK (field (&p, cases[i].k1) && strcmp (field (&p, cases[i].k1), cases[i].v1) == 0, cases[i].u);
		if (cases[i].k2) CHECK (field (&p, cases[i].k2) && strcmp (field (&p, cases[i].k2), cases[i].v2) == 0, cases[i].u);
		CHECK (p.t == cases[i].t, cases[i].u);
		CHECK (BarListenUriParse (p.https, &h) && strcmp (h.uri, p.uri) == 0, "https round trip");
		CHECK (BarListenUriParse (p.web, &w) && strcmp (w.uri, p.uri) == 0, "web+ round trip");
		BarListenUriFree (&h);
		BarListenUriFree (&w);
		BarListenUriFree (&p);
	}
	BarListenUri_t p;
	CHECK (!BarListenUriParse ("listen://artist/AC%2FDC", &p), "no slash inside a name");
	CHECK (BarListenUriBuild ("artist", "Guns N' Roses", NULL, -1, &p) &&
			strcmp (p.https, "https://spacegho.st/listen/artist/Guns%20N'%20Roses") == 0, "build https");
	BarListenUri_t q;
	CHECK (BarListenUriParse (p.uri, &q) && strcmp (q.field[0], "Guns N' Roses") == 0, "build round trip");
	BarListenUriFree (&q);
	BarListenUriFree (&p);
	free (track);
	free (a64);
}

static void rejectsAnythingNotAllowListed (void) {
	char * const long201 = repeat ('x', 201, "listen://artist/", "");
	const char *bad[] = {
		"listen://http://evil.example", "listen://url/https%3A%2F%2Fevil.example", "listen://artist", "listen://artist/a/b",
		"listen://artist/%00x", "listen://artist/%2e%2e", long201, "listen://artist/%E0%A4%A",
		"listen://artist/ x", "listen://artist/x?autoplay=1", "listen://track/zzz!?t=1", "listen://track/abc?t=999999",
		"listen://track/abc?t=1&t=2", "listen://map/Neon_Plains", "listen://map/a/b/c", "listen://user/A", "listen://station/12-34",
		"listen://artist/x#frag", "javascript:alert(1)", "https://evil.example/listen/artist/x", "https://spacegho.st/listen/../oauth/admin",
		"listen://listens/extra", "listen://artist/<script>",
		/* 42 (not a string) has no C equivalent */
		NULL,
	};
	for (size_t i = 0; i < sizeof (bad) / sizeof (*bad); i++) {
		BarListenUri_t p;
		CHECK (!BarListenUriParse (bad[i], &p), bad[i] ? bad[i] : "NULL");
	}
	BarListenUri_t p;
	CHECK (!BarListenUriBuild ("url", "x", NULL, -1, &p), "url target");
	CHECK (!BarListenUriBuild ("artist", "..", NULL, -1, &p), "..");
	CHECK (BarListenUriBuild ("artist", "...", NULL, -1, &p), "three dots is a name");
	BarListenUriFree (&p);
	CHECK (!BarListenUriBuild ("user", "NO", NULL, -1, &p), "NO");
	char decomposed[304];
	for (size_t i = 0; i < 101; i++) memcpy (decomposed + i * 3, "e\xcc\x81", 3);
	decomposed[303] = '\0';
	CHECK (!BarListenUriBuild ("artist", decomposed, NULL, -1, &p), "decoded length limit precedes normalization");
	free (long201);
}

static void routesStayOnMelodicaPages (void) {
	const struct { const char *u, *route; } want[] = {
		{ "listen://artist/Modest%20Mouse", "/melodica/app/?seed=artist:Modest%20Mouse" },
		{ "listen://map/neon-plains/synthwave-reach", "/melodica/map/?land=neon-plains&province=synthwave-reach" },
		{ "listen://track/abc?t=5", "/melodica/listens/?track=abc&t=5" },
	};
	for (size_t i = 0; i < sizeof (want) / sizeof (*want); i++) {
		BarListenUri_t p;
		CHECK (BarListenUriParse (want[i].u, &p), want[i].u);
		char * const r = BarListenUriRoute (&p);
		CHECK (r && strcmp (r, want[i].route) == 0, want[i].u);
		free (r);
		BarListenUriFree (&p);
	}
	const char *more[] = { "listen://listens", "listen://leaderboard", "listen://user/knewter", "listen://station/123", "listen://genre/dance" };
	for (size_t i = 0; i < sizeof (more) / sizeof (*more); i++) {
		BarListenUri_t p;
		CHECK (BarListenUriParse (more[i], &p), more[i]);
		char * const r = BarListenUriRoute (&p);
		CHECK (r && strncmp (r, "/melodica/", 10) == 0, more[i]);
		free (r);
		BarListenUriFree (&p);
	}
}

int main (int argc, char **argv) {
	if (argc > 1 && strcmp (argv[1], "--lines") == 0) {
		static char line[1 << 16];
		while (fgets (line, sizeof (line), stdin) != NULL) {
			line[strcspn (line, "\n")] = '\0';
			BarListenUri_t p;
			if (BarListenUriParse (line, &p)) {
				char * const r = BarListenUriRoute (&p);
				printf ("%s %s\n", p.uri, r);
				free (r);
				BarListenUriFree (&p);
			} else {
				printf ("null\n");
			}
		}
		return 0;
	}
	parsesEveryTarget ();
	rejectsAnythingNotAllowListed ();
	routesStayOnMelodicaPages ();
	if (failures) {
		fprintf (stderr, "%d failure(s)\n", failures);
		return 1;
	}
	printf ("listen_uri: all tests passed\n");
	return 0;
}
