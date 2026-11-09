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

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <wchar.h>

#include <windows.h>
#include <winhttp.h>

#include "listenbrainz_winhttp.h"

#ifdef _MSC_VER
#pragma comment(lib, "winhttp.lib")
#endif

static wchar_t *widen (const char *s) {
	const int n = MultiByteToWideChar (CP_UTF8, 0, s, -1, NULL, 0);
	if (n <= 0) {
		return NULL;
	}
	wchar_t * const w = malloc ((size_t) n * sizeof (*w));
	if (w != NULL && MultiByteToWideChar (CP_UTF8, 0, s, -1, w, n) <= 0) {
		free (w);
		return NULL;
	}
	return w;
}

static void wipe (wchar_t *w) {
	if (w != NULL) {
		SecureZeroMemory (w, wcslen (w) * sizeof (*w));
	}
	free (w);
}

/* One POST per call on its own session (not the Pandora connection). Returns
 * the HTTP status or 0. Nothing here prints; the Authorization header is
 * wiped from memory after use. */
long BarLbWinHttpPost (void *ctx, const char *url, const char *authorization,
		const char *body) {
	BarLbWinHttp_t * const c = ctx;
	long status = 0;
	const char *stage = NULL;
	HINTERNET session = NULL, connect = NULL, request = NULL;
	wchar_t *wurl = widen (url), *wproxy = NULL, *wheaders = NULL;

	const char * const prefix = "Content-Type: application/json\r\n"
			"Accept: application/json\r\nAuthorization: ";
	const size_t hn = strlen (prefix) + strlen (authorization) + 1;
	char * const headers = malloc (hn);
	if (headers != NULL) {
		snprintf (headers, hn, "%s%s", prefix, authorization);
		wheaders = widen (headers);
		SecureZeroMemory (headers, hn);
		free (headers);
	}
	if (wurl == NULL || wheaders == NULL) {
		stage = "memory";
		goto done;
	}

	URL_COMPONENTS parts;
	memset (&parts, 0, sizeof (parts));
	parts.dwStructSize = sizeof (parts);
	wchar_t host[256], path[2048];
	parts.lpszHostName = host;
	parts.dwHostNameLength = sizeof (host) / sizeof (*host);
	parts.lpszUrlPath = path;
	parts.dwUrlPathLength = sizeof (path) / sizeof (*path);
	if (!WinHttpCrackUrl (wurl, 0, 0, &parts)) {
		stage = "WinHttpCrackUrl";
		goto done;
	}
	const bool tls = parts.nScheme == INTERNET_SCHEME_HTTPS;

	if (c != NULL && c->proxy != NULL && c->proxy[0] != '\0') {
		const char *p = c->proxy;
		if (strncmp (p, "http://", 7) == 0) {
			p += 7;
		}
		wproxy = widen (p);
		if (wproxy != NULL) {
			const size_t pl = wcslen (wproxy);
			if (pl > 0 && wproxy[pl-1] == L'/') {
				wproxy[pl-1] = L'\0';
			}
		}
		session = WinHttpOpen (L"pianobar (melodica)",
				WINHTTP_ACCESS_TYPE_NAMED_PROXY, wproxy,
				WINHTTP_NO_PROXY_BYPASS, 0);
	} else {
		session = WinHttpOpen (L"pianobar (melodica)",
				WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
				WINHTTP_NO_PROXY_BYPASS, 0);
	}
	if (session == NULL) {
		stage = "WinHttpOpen";
		goto done;
	}
	const int timeout = (int) (c != NULL && c->timeoutMs ? c->timeoutMs : 10000);
	WinHttpSetTimeouts (session, timeout, timeout < 5000 ? timeout : 5000,
			timeout, timeout);
	connect = WinHttpConnect (session, host, parts.nPort, 0);
	if (connect == NULL) {
		stage = "WinHttpConnect";
		goto done;
	}
	request = WinHttpOpenRequest (connect, L"POST", path, NULL,
			WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
			tls ? WINHTTP_FLAG_SECURE : 0);
	if (request == NULL) {
		stage = "WinHttpOpenRequest";
		goto done;
	}
	const DWORD len = (DWORD) strlen (body);
	if (!WinHttpSendRequest (request, wheaders, (DWORD) -1L, (LPVOID) body,
			len, len, 0)) {
		stage = "WinHttpSendRequest";
		goto done;
	}
	if (!WinHttpReceiveResponse (request, NULL)) {
		stage = "WinHttpReceiveResponse";
		goto done;
	}
	DWORD code = 0, size = sizeof (code);
	if (WinHttpQueryHeaders (request, WINHTTP_QUERY_STATUS_CODE |
			WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &code,
			&size, WINHTTP_NO_HEADER_INDEX)) {
		status = (long) code;
	}
	/* drain the (small) answer */
	DWORD avail = 0;
	char sink[1024];
	while (WinHttpQueryDataAvailable (request, &avail) && avail > 0) {
		DWORD got = 0;
		if (!WinHttpReadData (request, sink, avail < sizeof (sink) ?
				avail : (DWORD) sizeof (sink), &got) || got == 0) {
			break;
		}
	}

done:
	if (c != NULL) {
		if (stage != NULL) {
			snprintf (c->error, sizeof (c->error), "%s failed (error %lu)",
					stage, (unsigned long) GetLastError ());
		} else {
			c->error[0] = '\0';
		}
	}
	if (request != NULL) {
		WinHttpCloseHandle (request);
	}
	if (connect != NULL) {
		WinHttpCloseHandle (connect);
	}
	if (session != NULL) {
		WinHttpCloseHandle (session);
	}
	wipe (wheaders);
	free (wurl);
	free (wproxy);
	return status;
}
