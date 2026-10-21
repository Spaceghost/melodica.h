#include "piano.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

typedef struct Fixture {
    PianoRequestType_t type;
    const char *name, *json;
} Fixture;

static const Fixture fixtures[] = {
    {PIANO_REQUEST_SEARCH, "search",
        "{\"stat\":\"ok\",\"result\":{\"artists\":[{\"artistName\":\"A\",\"musicToken\":[1,2]},"
        "{\"artistName\":\"B\"}],\"songs\":[{\"songName\":\"S\",\"artistName\":\"A\","
        "\"musicToken\":{\"x\":1}}]}}"},
    {PIANO_REQUEST_GET_STATION_INFO, "station_info",
        "{\"stat\":\"ok\",\"result\":{\"music\":{\"songs\":[{\"songName\":\"S\","
        "\"artistName\":\"A\",\"seedId\":\"s\"}],\"artists\":[{\"artistName\":\"A\",\"seedId\":\"a\"}]},"
        "\"feedback\":{\"thumbsUp\":[{\"songName\":\"U\",\"artistName\":\"A\",\"feedbackId\":\"f\","
        "\"isPositive\":true,\"trackLength\":\"123\"}],\"thumbsDown\":[{\"songName\":\"D\"}]}}}"},
    {PIANO_REQUEST_GET_GENRE_STATIONS, "genres",
        "{\"stat\":\"ok\",\"result\":{\"categories\":[{\"categoryName\":\"C\",\"stations\":[{"
        "\"stationName\":\"G\",\"stationToken\":\"g\"},{\"stationName\":\"H\",\"stationToken\":\"h\"}]},"
        "{\"categoryName\":\"D\",\"stations\":[]}]}}"},
    {PIANO_REQUEST_GET_STATION_MODES, "modes",
        "{\"stat\":\"ok\",\"result\":{\"currentModeId\":\"2\",\"availableModes\":[{\"modeId\":1,"
        "\"modeName\":\"One\",\"modeDescription\":\"First\"},{\"modeId\":\"2\","
        "\"modeName\":\"Two\",\"modeDescription\":{\"x\":true},\"isTakeoverMode\":true}]}}"},
    {PIANO_REQUEST_GET_SETTINGS, "settings",
        "{\"stat\":\"ok\",\"result\":{\"username\":{\"user\":\"new\"},\"isExplicitContentFilterEnabled\":true}}"},
    {PIANO_REQUEST_EXPLAIN, "explain",
        "{\"stat\":\"ok\",\"result\":{\"explanations\":[{\"focusTraitName\":\"first\"},"
        "{\"focusTraitName\":[\"second\"]},{\"focusTraitName\":\"third\"}]}}"}
};

typedef struct Context {
    PianoHandle_t ph;
    PianoRequest_t req;
    PianoRequestDataSearch_t search;
    PianoRequestDataGetStationInfo_t info;
    PianoRequestDataGetStationModes_t modes;
    PianoSettings_t settings;
    PianoRequestDataExplain_t explain;
    void *old;
} Context;

static char *copy(const char *text) {
    const size_t n = strlen(text) + 1u;
    char *p = (char *)malloc(n); assert(p != NULL); memcpy(p, text, n); return p;
}

static void prepare(Context *ctx, const Fixture *fixture) {
    memset(ctx, 0, sizeof(*ctx));
    assert(PianoInit(&ctx->ph, "p", "p", "d", "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    ctx->req.type = fixture->type; ctx->req.responseData = (char *)fixture->json;
    switch (fixture->type) {
        case PIANO_REQUEST_SEARCH: ctx->req.data = &ctx->search; break;
        case PIANO_REQUEST_GET_STATION_INFO:
            ctx->info.info.songSeeds = (PianoSong_t *)calloc(1u, sizeof(PianoSong_t));
            assert(ctx->info.info.songSeeds != NULL);
            ctx->old = ctx->info.info.songSeeds; ctx->req.data = &ctx->info; break;
        case PIANO_REQUEST_GET_GENRE_STATIONS:
            ctx->ph.genreStations = (PianoGenreCategory_t *)calloc(1u, sizeof(PianoGenreCategory_t));
            assert(ctx->ph.genreStations != NULL);
            ctx->ph.genreStations->name = copy("old"); ctx->old = ctx->ph.genreStations; break;
        case PIANO_REQUEST_GET_STATION_MODES:
            ctx->modes.retModes = (PianoStationMode_t *)calloc(1u, sizeof(PianoStationMode_t));
            assert(ctx->modes.retModes != NULL);
            ctx->modes.retModes->name = copy("old"); ctx->old = ctx->modes.retModes;
            ctx->req.data = &ctx->modes; break;
        case PIANO_REQUEST_GET_SETTINGS:
            ctx->settings.username = copy("old"); ctx->old = ctx->settings.username;
            ctx->req.data = &ctx->settings; break;
        case PIANO_REQUEST_EXPLAIN:
            ctx->explain.retExplain = copy("old"); ctx->old = ctx->explain.retExplain;
            ctx->req.data = &ctx->explain; break;
        default: abort();
    }
}

static void unchanged(const Context *ctx) {
    switch (ctx->req.type) {
        case PIANO_REQUEST_SEARCH:
            assert(ctx->search.searchResult.artists == NULL && ctx->search.searchResult.songs == NULL); break;
        case PIANO_REQUEST_GET_STATION_INFO:
            assert(ctx->info.info.songSeeds == ctx->old && ctx->info.info.songSeeds->head.next == NULL);
            assert(ctx->info.info.artistSeeds == NULL && ctx->info.info.feedback == NULL); break;
        case PIANO_REQUEST_GET_GENRE_STATIONS:
            assert(ctx->ph.genreStations == ctx->old && ctx->ph.genreStations->head.next == NULL); break;
        case PIANO_REQUEST_GET_STATION_MODES:
            assert(ctx->modes.retModes == ctx->old && ctx->modes.retModes->head.next == NULL); break;
        case PIANO_REQUEST_GET_SETTINGS: assert(ctx->settings.username == ctx->old); break;
        case PIANO_REQUEST_EXPLAIN: assert(ctx->explain.retExplain == ctx->old); break;
        default: abort();
    }
}

static void destroy(Context *ctx) {
    switch (ctx->req.type) {
        case PIANO_REQUEST_SEARCH: PianoDestroySearchResult(&ctx->search.searchResult); break;
        case PIANO_REQUEST_GET_STATION_INFO: PianoDestroyStationInfo(&ctx->info.info); break;
        case PIANO_REQUEST_GET_STATION_MODES: PianoDestroyStationMode(ctx->modes.retModes); break;
        case PIANO_REQUEST_GET_SETTINGS:
            if (ctx->settings.username != ctx->old) free(ctx->old);
            free(ctx->settings.username); break;
        case PIANO_REQUEST_EXPLAIN:
            if (ctx->explain.retExplain != ctx->old) free(ctx->old);
            free(ctx->explain.retExplain); break;
        default: break;
    }
    PianoDestroy(&ctx->ph);
    assert(live == 0u);
}

int main(void) {
    for (size_t i = 0u; i < sizeof(fixtures)/sizeof(*fixtures); ++i) {
        Context ctx; prepare(&ctx, &fixtures[i]);
        calls = 0u; fail_on = SIZE_MAX;
        PianoReturn_t ret = PianoResponse(&ctx.ph, &ctx.req);
        const size_t allocations = calls;
        fail_on = 0u; assert(ret == PIANO_RET_OK); destroy(&ctx);
        for (size_t n = 1u; n <= allocations; ++n) {
            prepare(&ctx, &fixtures[i]); calls = 0u; fail_on = n;
            ret = PianoResponse(&ctx.ph, &ctx.req); fail_on = 0u;
            assert(ret == PIANO_RET_OUT_OF_MEMORY || ret == PIANO_RET_INVALID_RESPONSE);
            unchanged(&ctx); destroy(&ctx);
        }
        printf("%s allocation failures: %zu checked, no leaks or partial output\n", fixtures[i].name, allocations);
    }
    return 0;
}
