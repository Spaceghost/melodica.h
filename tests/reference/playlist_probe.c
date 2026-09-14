#define _POSIX_C_SOURCE 200809L
#include "piano.h"
#include "playlist_fixtures.h"
#include <assert.h>
#include <stdint.h>
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

static void print_string(const char *key, const char *s) {
    printf("%s=", key);
    if (s == NULL) fputs("<null>", stdout);
    else for (; *s != '\0'; ++s) printf("%02x", (unsigned char)*s);
    putchar('\n');
}

static size_t list_count(const PianoSong_t *s) {
    size_t n = 0;
    for (; s != NULL; s = (const PianoSong_t *)s->head.next) ++n;
    return n;
}

static void response_case(PianoHandle_t *ph, const char *label, const char *json,
        PianoAudioQuality_t quality, PianoReturn_t expected, size_t count, int unchanged) {
    PianoSong_t sentinel = {0};
    PianoRequestDataGetPlaylist_t data = {0};
    data.quality = quality;
    data.retPlaylist = &sentinel;
    PianoRequest_t req = {0};
    req.type = PIANO_REQUEST_GET_PLAYLIST;
    req.data = &data;
    req.responseData = (char *)json;
    PianoReturn_t ret = PianoResponse(ph, &req);
    printf("%s.ret=%d unchanged=%d\n", label, (int)ret, data.retPlaylist == &sentinel);
    assert(ret == expected);
    assert((data.retPlaylist == &sentinel) == unchanged);
    if (unchanged) return;
    assert(list_count(data.retPlaylist) == count);
    printf("%s.count=%zu\n", label, count);
    for (PianoSong_t *s = data.retPlaylist; s != NULL; s = (PianoSong_t *)s->head.next) {
        print_string("artist", s->artist); print_string("album", s->album);
        print_string("title", s->title); print_string("track", s->trackToken);
        print_string("station", s->stationId); print_string("audio", s->audioUrl);
        print_string("cover", s->coverArt); print_string("detail", s->detailUrl);
        print_string("music", s->musicId); print_string("seed", s->seedId);
        print_string("feedback", s->feedbackId);
        printf("format=%d rating=%d length=%u gain=%.9g\n",
            (int)s->audioFormat, (int)s->rating, s->length, (double)s->fileGain);
    }
    PianoDestroyPlaylist(data.retPlaylist);
}

static void request_case(PianoHandle_t *ph, const char *station_id) {
    PianoStation_t station = {0};
    station.id = (char *)station_id;
    PianoRequestDataGetPlaylist_t data = {0};
    data.station = &station;
    data.quality = PIANO_AQ_HIGH;
    PianoRequest_t req = {0};
    req.data = &data;
    PianoReturn_t ret = PianoRequest(ph, &req, PIANO_REQUEST_GET_PLAYLIST);
    assert(ret == PIANO_RET_OK && req.secure && req.type == PIANO_REQUEST_GET_PLAYLIST);
    print_string("request.url", req.urlPath);
    print_string("request.ciphertext", req.postData);
    printf("request.secure=%d\n", req.secure);
    PianoDestroyRequest(&req);
}

static uint64_t ns_now(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) abort();
    return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
}
static uint64_t median(uint64_t *a) {
    for (size_t i = 1; i < 5u; ++i) {
        uint64_t v = a[i]; size_t j = i;
        while (j != 0u && a[j-1u] > v) { a[j] = a[j-1u]; --j; }
        a[j] = v;
    }
    return a[2];
}
static volatile size_t sink;

static void bench_response(PianoHandle_t *ph, const size_t songs, const unsigned iterations) {
    const char *prefix = "{\"stat\":\"ok\",\"result\":{\"items\":[";
    const char *suffix = "]}}";
    const char *song = PLAYLIST_SONG;
    const size_t capacity = strlen(prefix) + songs * (strlen(song) + 1u) + strlen(suffix) + 1u;
    char *json = (char *)malloc(capacity), *p = json;
    assert(json != NULL);
    memcpy(p, prefix, strlen(prefix)); p += strlen(prefix);
    for (size_t i = 0; i < songs; ++i) {
        if (i != 0u) *p++ = ',';
        memcpy(p, song, strlen(song)); p += strlen(song);
    }
    strcpy(p, suffix);
    PianoRequestDataGetPlaylist_t data = {0}; data.quality = PIANO_AQ_HIGH;
    PianoRequest_t req = {0}; req.type = PIANO_REQUEST_GET_PLAYLIST;
    req.data = &data; req.responseData = json;
    uint64_t samples[5];
    /* Warm up with exactly the measured work, including ownership cleanup. */
    for (unsigned round = 0; round < 6u; ++round) {
        uint64_t start = ns_now();
        for (unsigned i = 0; i < iterations; ++i) {
            PianoReturn_t ret = PianoResponse(ph, &req);
            if (ret != PIANO_RET_OK || list_count(data.retPlaylist) != songs) abort();
            sink += data.retPlaylist->length + (unsigned char)data.retPlaylist->artist[0];
            PianoDestroyPlaylist(data.retPlaylist); data.retPlaylist = NULL;
        }
        if (round != 0u) samples[round-1u] = ns_now() - start;
    }
    printf("playlist_parse_%zu %.3f requests/s median_of=5 iterations=%u\n",
        songs, (double)iterations * 1e9 / (double)median(samples), iterations);
    free(json);
}

int main(int argc, char **argv) {
#ifdef MELODICA_REFERENCE_UPSTREAM
    if (gcry_check_version(NULL) == NULL) return 90;
#endif
    PianoHandle_t ph;
    PianoReturn_t ret = PianoInit(&ph, "partner", "password", "device", "abcdefgh", "ijklmnop");
    assert(ret == PIANO_RET_OK);
    ph.partner.id = 42; ph.timeOffset = 123;
    ph.user.listenerId = copy_string("listener-7");
    ph.user.authToken = copy_string("user token/?\"\\\001\037");
    if (argc == 2 && strcmp(argv[1], "--bench") == 0) {
        bench_response(&ph, 4u, 10000u);
        bench_response(&ph, 64u, 750u);
        bench_response(&ph, 256u, 150u);
        PianoDestroy(&ph);
        return 0;
    }
    assert(argc == 1);
    request_case(&ph, "station-token");
    request_case(&ph, "station/\"\\\n\001\037");
    char controls[32];
    for (unsigned i = 1; i < 32u; ++i) controls[i-1u] = (char)i;
    controls[31] = '\0';
    request_case(&ph, controls);
    response_case(&ph, "low", PLAYLIST_FOUR, PIANO_AQ_LOW, PIANO_RET_OK, 4u, 0);
    response_case(&ph, "medium", PLAYLIST_FOUR, PIANO_AQ_MEDIUM, PIANO_RET_OK, 4u, 0);
    response_case(&ph, "high", PLAYLIST_FOUR, PIANO_AQ_HIGH, PIANO_RET_OK, 4u, 0);
    response_case(&ph, "mixed", PLAYLIST_MIXED, PIANO_AQ_HIGH, PIANO_RET_OK, 3u, 0);
    response_case(&ph, "empty", "{\"stat\":\"ok\",\"result\":{\"items\":[]}}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 0);
    response_case(&ph, "absent", "{\"stat\":\"ok\",\"result\":{}}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 1);
    response_case(&ph, "missing_result", "{\"stat\":\"ok\"}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 1);
    response_case(&ph, "null_result", "{\"stat\":\"ok\",\"result\":null}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 1);
    response_case(&ph, "scalar_result", "{\"stat\":\"ok\",\"result\":true}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 1);
    response_case(&ph, "array_result", "{\"stat\":\"ok\",\"result\":[]}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 1);
    response_case(&ph, "ads", "{\"stat\":\"ok\",\"result\":{\"items\":[{\"adToken\":\"ad\"}]}}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 0u, 0);
    response_case(&ph, "late_failure", PLAYLIST_LATE_FAILURE,
        PIANO_AQ_HIGH, PIANO_RET_QUALITY_UNAVAILABLE, 0u, 1);
    response_case(&ph, "missing_encoding", "{\"stat\":\"ok\",\"result\":{\"items\":[{"
        "\"artistName\":\"A\",\"audioUrlMap\":{\"highQuality\":{}}}]}}",
        PIANO_AQ_HIGH, PIANO_RET_QUALITY_UNAVAILABLE, 0u, 1);
    response_case(&ph, "escaped_encoding", "{\"stat\":\"ok\",\"result\":{\"items\":[{"
        "\"artistName\":\"A\",\"audioUrlMap\":{\"highQuality\":{\"encoding\":\"mp\\u0033\"}}}]}}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 1u, 0);
    response_case(&ph, "numeric", "{\"stat\":\"ok\",\"result\":{\"items\":[{"
        "\"artistName\":\"A\",\"trackGain\":\"-2.5\",\"trackLength\":\"12.75\",\"songRating\":true},"
        "{\"artistName\":\"B\",\"trackGain\":1.25e1,\"trackLength\":12.75,\"songRating\":2},"
        "{\"artistName\":\"C\",\"trackLength\":4294967295},"
        "{\"artistName\":\"D\",\"trackLength\":-1}]}}",
        PIANO_AQ_HIGH, PIANO_RET_OK, 4u, 0);
    response_case(&ph, "error", "{\"stat\":\"fail\",\"code\":1001}",
        PIANO_AQ_HIGH, PIANO_RET_P_INVALID_AUTH_TOKEN, 0u, 1);
    PianoDestroy(&ph);
    puts("playlist probe: 3 request cases, 16 response cases passed");
    return 0;
}
