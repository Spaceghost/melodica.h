#define _POSIX_C_SOURCE 200809L
#include "piano.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef MELODICA_REFERENCE_UPSTREAM
#include <gcrypt.h>
#endif

time_t time(time_t *out) {
    const time_t now = (time_t)1700000000;
    if (out != NULL) *out = now;
    return now;
}

static char *copy_string(const char *s) {
    char *out = (char *)malloc(strlen(s) + 1u);
    assert(out != NULL);
    memcpy(out, s, strlen(s) + 1u);
    return out;
}

static void print_hex(const char *key, const char *s) {
    printf("%s=", key);
    if (s == NULL) fputs("<null>", stdout);
    else for (; *s != '\0'; ++s) printf("%02x", (unsigned char)*s);
    putchar('\n');
}

static size_t artist_count(const PianoArtist_t *a) {
    size_t n = 0u;
    for (; a != NULL; a = (const PianoArtist_t *)a->head.next) ++n;
    return n;
}

static size_t song_count(const PianoSong_t *s) {
    size_t n = 0u;
    for (; s != NULL; s = (const PianoSong_t *)s->head.next) ++n;
    return n;
}

static void empty_result_case(PianoHandle_t *ph, const char *label, const char *json) {
    PianoArtist_t artist_sentinel = {0};
    PianoSong_t song_sentinel = {0};
    PianoRequestDataSearch_t data;
    memset(&data, 0, sizeof(data));
    data.searchResult.artists = &artist_sentinel;
    data.searchResult.songs = &song_sentinel;
    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_SEARCH;
    req.data = &data;
    req.responseData = (char *)json;
    const PianoReturn_t ret = PianoResponse(ph, &req);
    assert(ret == PIANO_RET_OK);
    assert(data.searchResult.artists == NULL && data.searchResult.songs == NULL);
    printf("%s.ret=%d artists=%zu songs=%zu\n", label, (int)ret,
        artist_count(data.searchResult.artists), song_count(data.searchResult.songs));
}

int main(void) {
#ifdef MELODICA_REFERENCE_UPSTREAM
    if (gcry_check_version(NULL) == NULL) return 90;
#endif
    PianoHandle_t ph;
    PianoReturn_t ret = PianoInit(&ph, "partner", "password", "device",
        "abcdefgh", "ijklmnop");
    assert(ret == PIANO_RET_OK);
    ph.partner.id = 42u;
    ph.timeOffset = 123;
    ph.user.listenerId = copy_string("listener-7");
    ph.user.authToken = copy_string("user token/?\"\\\001\037");

    PianoRequestDataSearch_t data;
    memset(&data, 0, sizeof(data));
    data.searchStr = (char *)"Bjoerk / \"Joga\" \\ \001";
    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &data;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_SEARCH);
    assert(ret == PIANO_RET_OK);
    printf("request.ret=%d secure=%d type=%d\n", (int)ret, req.secure ? 1 : 0, (int)req.type);
    print_hex("request.url", req.urlPath);
    print_hex("request.ciphertext", req.postData);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_SEARCH;
    req.data = &data;
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{"
        "\"artists\":["
        "{\"artistName\":\"Bj\\u00f6rk\",\"musicToken\":\"artist-1\"},"
        "{\"artistName\":\"A/B\",\"musicToken\":\"artist-2\"}],"
        "\"songs\":["
        "{\"songName\":\"J\\u00f3ga\",\"artistName\":\"Bj\\u00f6rk\",\"musicToken\":\"song-1\"},"
        "{\"songName\":\"Army of Me\",\"artistName\":\"Bj\\u00f6rk\",\"musicToken\":\"song-2\"}]}}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_OK);
    printf("response.ret=%d artists=%zu songs=%zu\n", (int)ret,
        artist_count(data.searchResult.artists), song_count(data.searchResult.songs));
    for (PianoArtist_t *a = data.searchResult.artists; a != NULL;
            a = (PianoArtist_t *)a->head.next) {
        print_hex("artist.name", a->name);
        print_hex("artist.music", a->musicId);
    }
    for (PianoSong_t *s = data.searchResult.songs; s != NULL;
            s = (PianoSong_t *)s->head.next) {
        print_hex("song.title", s->title);
        print_hex("song.artist", s->artist);
        print_hex("song.music", s->musicId);
    }
    PianoDestroySearchResult(&data.searchResult);

    memset(&data.searchResult, 0, sizeof(data.searchResult));
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_OK);
    printf("empty.ret=%d artists=%zu songs=%zu\n", (int)ret,
        artist_count(data.searchResult.artists), song_count(data.searchResult.songs));
    PianoDestroySearchResult(&data.searchResult);

    empty_result_case(&ph, "missing_result", "{\"stat\":\"ok\"}");
    empty_result_case(&ph, "null_result", "{\"stat\":\"ok\",\"result\":null}");
    empty_result_case(&ph, "scalar_result", "{\"stat\":\"ok\",\"result\":true}");
    empty_result_case(&ph, "array_result", "{\"stat\":\"ok\",\"result\":[]}");

    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_P_INVALID_AUTH_TOKEN);
    printf("error.ret=%d\n", (int)ret);

    PianoDestroy(&ph);
    puts("search probe: request, populated response, five empty-result shapes and error passed");
    return 0;
}
