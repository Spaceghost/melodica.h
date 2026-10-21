#include "piano.h"
#include "reference/playlist_fixtures.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef MELODICA_ALLOC_FAILURE_TEST
void *__real_malloc(size_t);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);
void __real_free(void *);
static size_t live, calls, fail_on;
static int fail_now(void) { return fail_on != 0u && ++calls == fail_on; }
void *__wrap_malloc(size_t n) {
    if (fail_now()) return NULL;
    void *p = __real_malloc(n); if (p != NULL) ++live; return p;
}
void *__wrap_calloc(size_t n, size_t s) {
    if (fail_now()) return NULL;
    void *p = __real_calloc(n, s); if (p != NULL) ++live; return p;
}
void *__wrap_realloc(void *p, size_t n) {
    if (fail_now()) return NULL;
    const int fresh = p == NULL;
    void *q = __real_realloc(p, n);
    if (q != NULL && fresh) ++live;
    return q;
}
void __wrap_free(void *p) {
    if (p != NULL) { assert(live != 0u); --live; }
    __real_free(p);
}
#endif

static PianoReturn_t respond(PianoHandle_t *ph, PianoRequestDataGetPlaylist_t *data,
        const char *text) {
    PianoRequest_t req = {0};
    req.type = PIANO_REQUEST_GET_PLAYLIST; req.data = data;
    req.responseData = (char *)text;
    return PianoResponse(ph, &req);
}

int main(void) {
    PianoHandle_t ph;
    PianoReturn_t ret = PianoInit(&ph, "partner", "password", "device", "abcdefgh", "ijklmnop");
    assert(ret == PIANO_RET_OK);
    PianoRequestDataGetPlaylist_t data = {0};
    data.quality = PIANO_AQ_HIGH;
    ret = respond(&ph, &data, PLAYLIST_FOUR);
    assert(ret == PIANO_RET_OK && data.retPlaylist != NULL);
    size_t count = 0;
    for (PianoSong_t *s = data.retPlaylist; s != NULL; s = (PianoSong_t *)s->head.next) {
        assert(strcmp(s->artist, "Artist \xe2\x99\xab") == 0);
        assert(strcmp(s->title, "Song \"one\"") == 0);
        assert(strcmp(s->audioUrl, "https://example.invalid/high") == 0);
        assert(s->audioFormat == PIANO_AF_MP3 && s->rating == PIANO_RATE_LOVE);
        assert(s->fileGain == -3.25f && s->length == 123u);
        ++count;
    }
    assert(count == 4u);
    PianoDestroyPlaylist(data.retPlaylist);

    /* Malformed input must not replace caller-owned output or leak partial songs. */
    static const char *const malformed[] = {
        "{\"stat\":\"ok\",\"result\":{\"items\":null}}",
        "{\"stat\":\"ok\",\"result\":{\"items\":{}}}",
        "{\"stat\":\"ok\",\"result\":{\"items\":[{\"artistName\":null}]}}",
        "{\"stat\":\"ok\",\"result\":{\"items\":[{\"artistName\":\"A\",\"trackGain\":oops}]}}"
    };
    PianoSong_t sentinel = {0};
    for (size_t i = 0; i < sizeof(malformed)/sizeof(*malformed); ++i) {
        data.retPlaylist = &sentinel;
        assert(respond(&ph, &data, malformed[i]) == PIANO_RET_INVALID_RESPONSE);
        assert(data.retPlaylist == &sentinel);
    }
    static const char *const empty_success[] = {
        "{\"stat\":\"ok\"}", "{\"stat\":\"ok\",\"result\":[]}",
        "{\"stat\":\"ok\",\"result\":null}", "{\"stat\":\"ok\",\"result\":false}"
    };
    for (size_t i = 0; i < sizeof(empty_success)/sizeof(*empty_success); ++i) {
        data.retPlaylist = &sentinel;
        assert(respond(&ph, &data, empty_success[i]) == PIANO_RET_OK);
        assert(data.retPlaylist == &sentinel);
    }
    data.quality = PIANO_AQ_UNKNOWN;
    assert(respond(&ph, &data, PLAYLIST_FOUR) == PIANO_RET_INVALID_RESPONSE);
    data.quality = PIANO_AQ_HIGH;
    PianoRequest_t unsupported = {0};
    unsupported.type = PIANO_REQUEST_ADD_FEEDBACK;
    unsupported.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    assert(PianoResponse(&ph, &unsupported) == PIANO_RET_ERR);

    PianoRequest_t request = {0};
    request.data = &data;
    assert(PianoRequest(&ph, &request, PIANO_REQUEST_GET_PLAYLIST) == PIANO_RET_ERR);
    assert(request.postData == NULL);

#ifdef MELODICA_ALLOC_FAILURE_TEST
    const size_t baseline = live;
    data.retPlaylist = &sentinel;
    calls = 0u; fail_on = SIZE_MAX;
    ret = respond(&ph, &data, PLAYLIST_FOUR);
    size_t allocations = calls;
    fail_on = 0u;
    assert(ret == PIANO_RET_OK);
    PianoDestroyPlaylist(data.retPlaylist);
    assert(live == baseline);
    for (size_t n = 1u; n <= allocations; ++n) {
        data.retPlaylist = &sentinel;
        calls = 0u; fail_on = n;
        ret = respond(&ph, &data, PLAYLIST_FOUR);
        fail_on = 0u;
        assert(ret == PIANO_RET_OUT_OF_MEMORY || ret == PIANO_RET_INVALID_RESPONSE);
        assert(data.retPlaylist == &sentinel);
        assert(live == baseline);
    }
    printf("playlist allocation failures: %zu checked, no leaks or output mutation\n", allocations);
#endif
    PianoDestroy(&ph);
#ifdef MELODICA_ALLOC_FAILURE_TEST
    assert(live == 0u);
#endif
    puts("playlist safety: metadata, malformed input, ownership and unsupported responses passed");
    return 0;
}
