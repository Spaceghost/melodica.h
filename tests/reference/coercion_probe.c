#define _POSIX_C_SOURCE 200809L
#include "piano.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef MELODICA_REFERENCE_UPSTREAM
#include <gcrypt.h>
#endif

/* Exercise defined json-c conversions through public libpiano entry points.
 * Null string fields and null array elements are excluded: upstream passes
 * those to strdup/assert and has no successful contract for them. */
static void string(const char *text) {
    if (text == NULL) fputs("<null>", stdout);
    else for (; *text != '\0'; ++text) printf("%02x", (unsigned char)*text);
    putchar(' ');
}

static PianoReturn_t response(PianoHandle_t *ph, PianoRequestType_t type,
        void *data, char *json) {
    PianoRequest_t req = {0};
    req.type = type; req.data = data; req.responseData = json;
    return PianoResponse(ph, &req);
}

static void value_cases(const char *value, size_t index) {
    PianoHandle_t ph;
    assert(PianoInit(&ph, "p", "p", "d", "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    char json[4096];
    PianoSettings_t settings = {0};
    snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{\"username\":%s,"
        "\"isExplicitContentFilterEnabled\":%s}}", value, value);
    printf("settings.%zu %d ", index, response(&ph, PIANO_REQUEST_GET_SETTINGS, &settings, json));
    string(settings.username); printf("%d\n", settings.explicitContentFilter);
    free(settings.username);

    PianoRequestDataGetPlaylist_t playlist = {0}; playlist.quality = PIANO_AQ_HIGH;
    snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{\"items\":[{"
        "\"artistName\":%s,\"trackLength\":%s,\"songRating\":%s,\"trackGain\":%s},42,false,[]]}}",
        value, value, value, value);
    printf("playlist.%zu %d ", index, response(&ph, PIANO_REQUEST_GET_PLAYLIST, &playlist, json));
    if (playlist.retPlaylist != NULL) {
        string(playlist.retPlaylist->artist);
        printf("%u %d %.9g", playlist.retPlaylist->length,
            playlist.retPlaylist->rating, (double)playlist.retPlaylist->fileGain);
    }
    putchar('\n'); PianoDestroyPlaylist(playlist.retPlaylist);

    PianoRequestDataSearch_t search = {0};
    snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{\"artists\":[{"
        "\"artistName\":%s,\"musicToken\":%s},42],\"songs\":[{\"songName\":%s},false]}}",
        value, value, value);
    printf("search.%zu %d ", index, response(&ph, PIANO_REQUEST_SEARCH, &search, json));
    if (search.searchResult.artists != NULL) {
        string(search.searchResult.artists->name); string(search.searchResult.artists->musicId);
        string(((PianoArtist_t *)search.searchResult.artists->head.next)->name);
    }
    if (search.searchResult.songs != NULL) string(search.searchResult.songs->title);
    putchar('\n'); PianoDestroySearchResult(&search.searchResult);

    PianoRequestDataGetStationModes_t modes = {0};
    snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{\"currentModeId\":%s,"
        "\"availableModes\":[{\"modeId\":%s,\"modeName\":%s,\"modeDescription\":%s,"
        "\"isAlgorithmicMode\":%s,\"isTakeoverMode\":%s}]}}", value,value,value,value,value,value);
    printf("modes.%zu %d ", index, response(&ph, PIANO_REQUEST_GET_STATION_MODES, &modes, json));
    if (modes.retModes != NULL) {
        printf("%d %d %d %d ", modes.retModes->id, modes.retModes->active,
            modes.retModes->isAlgorithmic, modes.retModes->isTakeover);
        string(modes.retModes->name); string(modes.retModes->description);
    }
    putchar('\n'); PianoDestroyStationMode(modes.retModes);

    PianoRequestDataExplain_t explain = {0};
    snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{\"explanations\":[{"
        "\"focusTraitName\":%s}]}}", value);
    printf("explain.%zu %d ", index, response(&ph, PIANO_REQUEST_EXPLAIN, &explain, json));
    string(explain.retExplain); putchar('\n'); free(explain.retExplain);

    snprintf(json, sizeof(json), "{\"stat\":false,\"code\":%s}", value);
    printf("error.%zu %d\n", index, response(&ph, PIANO_REQUEST_BOOKMARK_SONG, NULL, json));
    PianoDestroy(&ph);
}

int main(void) {
#ifdef MELODICA_REFERENCE_UPSTREAM
    assert(gcry_check_version(NULL) != NULL);
#endif
    static const char *const values[] = {
        "true", "false", "0", "1", "-1", "2147483648", "-2147483649", "1.75", "-1.75",
        "1e2", "1e999", "\"\"", "\"false\"", "\"0\"", "\"12.75\"", "\"  -2tail\"",
        "\"\\u0000tail\"", "\"\\ud800X\\udc00\"", "[]", "{}", "[1,\"a/b\",null]",
        "{\"x\":1,\"y\":true,\"x\":2}", "{\"x\":{},\"y\":[],\"z\":\"a\\u0000b\"}"
    };
    for (size_t i = 0; i < sizeof(values)/sizeof(*values); ++i) value_cases(values[i], i);

    PianoHandle_t ph;
    assert(PianoInit(&ph, "p", "p", "d", "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    static const char *const documents[] = {
        "{/* comment */\"stat\":\"ok\"}", "{\"stat\":\"ok\",}",
        "{\"stat\":\"ok\",\"x\":[1,2,]}", "{'stat':'ok'}",
        "{\"stat\":\"ok\"} trailing", "{\"stat\":\"ok\",\"x\":NaN}",
        "{\"stat\":\"ok\",\"x\":Infinity}", "{\"stat\":\"ok\",\"x\":TRUE}",
        "{\"stat\":\"ok\",\"x\":01}", "{\"stat\":\"ok\",\"x\":+1}",
        "{\"stat\":\"ok\",\"x\":oops}", "{\"stat\":\"ok\",\"x\":1e}",
        "{\"stat\":\"ok\",\"x\":.5}", "{\"stat\":\"ok\",\"x\":0x10}"
    };
    for (size_t i = 0; i < sizeof(documents)/sizeof(*documents); ++i) {
        printf("parser.%zu %d\n", i, response(&ph, PIANO_REQUEST_BOOKMARK_SONG,
            NULL, (char *)documents[i]));
    }
    PianoSettings_t settings = {0};
    char escaped[] = "{\"stat\":\"fail\",\"st\\u0061t\":\"o\\u006b\",\"result\":{"
        "\"username\":\"first\",\"user\\u006eame\":\"last\","
        "\"isExplicitContentFilterEnabled\":true,\"isExplicitContentFilterEnabled\":null}}";
    printf("escaped.duplicate %d ", response(&ph, PIANO_REQUEST_GET_SETTINGS, &settings, escaped));
    string(settings.username); printf("%d\n", settings.explicitContentFilter); free(settings.username);
    PianoRequestDataLogin_t login = {0}; login.step = 1;
    char empty[] = "{\"stat\":\"ok\",\"result\":{}}";
    printf("login.empty %d\n", response(&ph, PIANO_REQUEST_LOGIN, &login, empty));
    PianoRequestDataGetStationInfo_t info = {0};
    char missing[] = "{\"stat\":\"ok\"}";
    printf("station_info.missing %d\n", response(&ph, PIANO_REQUEST_GET_STATION_INFO, &info, missing));
    PianoDestroyStationInfo(&info.info);
    PianoDestroy(&ph);
    return 0;
}
