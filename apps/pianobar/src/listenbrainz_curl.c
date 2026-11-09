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

#if !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include "listenbrainz_curl.h"

static size_t discard (char *ptr, size_t size, size_t nmemb, void *data) {
	(void) ptr;
	(void) data;
	return size * nmemb;
}

/* One POST on its own handle (never the Pandora one), no verbose output, so
 * the Authorization header never reaches a log. */
long BarLbCurlPost (void *ctx, const char *url, const char *authorization,
		const char *body) {
	BarLbCurl_t * const c = ctx;
	if (c->http == NULL && (c->http = curl_easy_init ()) == NULL) {
		return 0;
	}
	CURL * const h = c->http;
	curl_easy_reset (h);

	const size_t n = strlen ("Authorization: ") + strlen (authorization) + 1;
	char * const auth = malloc (n);
	if (auth == NULL) {
		return 0;
	}
	snprintf (auth, n, "Authorization: %s", authorization);
	struct curl_slist *headers = NULL;
	headers = curl_slist_append (headers, "Content-Type: application/json");
	headers = curl_slist_append (headers, "Accept: application/json");
	headers = curl_slist_append (headers, auth);
	memset (auth, 0, n);
	free (auth);

	const long timeout = c->timeout > 0 ? c->timeout : 10;
	curl_easy_setopt (h, CURLOPT_URL, url);
	curl_easy_setopt (h, CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt (h, CURLOPT_POSTFIELDS, body);
	curl_easy_setopt (h, CURLOPT_POSTFIELDSIZE, (long) strlen (body));
	curl_easy_setopt (h, CURLOPT_WRITEFUNCTION, discard);
	curl_easy_setopt (h, CURLOPT_NOSIGNAL, 1L);
	curl_easy_setopt (h, CURLOPT_CONNECTTIMEOUT, timeout < 5 ? timeout : 5L);
	curl_easy_setopt (h, CURLOPT_TIMEOUT, timeout);
	curl_easy_setopt (h, CURLOPT_USERAGENT, "pianobar (melodica)");
#if LIBCURL_VERSION_NUM >= 0x075500
	curl_easy_setopt (h, CURLOPT_PROTOCOLS_STR, "http,https");
#else
	curl_easy_setopt (h, CURLOPT_PROTOCOLS,
			(long) (CURLPROTO_HTTP | CURLPROTO_HTTPS));
#endif
	if (c->proxy != NULL && c->proxy[0] != '\0') {
		curl_easy_setopt (h, CURLOPT_PROXY, c->proxy);
	}
	if (c->caBundle != NULL && c->caBundle[0] != '\0') {
		curl_easy_setopt (h, CURLOPT_CAINFO, c->caBundle);
	}

	long status = 0;
	if (curl_easy_perform (h) == CURLE_OK) {
		curl_easy_getinfo (h, CURLINFO_RESPONSE_CODE, &status);
	}
	curl_slist_free_all (headers);
	/* the header list is gone; make sure the handle forgets it too */
	curl_easy_reset (h);
	return status;
}
