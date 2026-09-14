#include "piano.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef MELODICA_REFERENCE_UPSTREAM
#include <gcrypt.h>
#endif

static const time_t FIXED_TIME = (time_t)1700000000;

time_t time(time_t *out) {
    if (out != NULL) *out = FIXED_TIME;
    return FIXED_TIME;
}

static char *copy_string(const char *s) {
    const size_t n = strlen(s) + 1u;
    char *out = (char *)malloc(n);
    if (out == NULL) abort();
    memcpy(out, s, n);
    return out;
}

static PianoStation_t *new_station(const char *id, const int use_quickmix,
        const int is_quickmix, const int is_creator) {
    PianoStation_t *station = (PianoStation_t *)calloc(1u, sizeof(*station));
    if (station == NULL) abort();
    station->id = copy_string(id);
    station->useQuickMix = (char)use_quickmix;
    station->isQuickMix = (char)is_quickmix;
    station->isCreator = (char)is_creator;
    return station;
}

static void print_request(const char *label, const PianoReturn_t ret,
        const PianoRequest_t *req) {
    printf("%s.ret=%d\n", label, (int)ret);
    printf("%s.type=%d\n", label, (int)req->type);
    printf("%s.secure=%d\n", label, req->secure ? 1 : 0);
    printf("%s.url=%s\n", label, req->urlPath);
    printf("%s.post=%s\n", label, req->postData != NULL ? req->postData : "<null>");
}

static size_t category_count(const PianoGenreCategory_t *category) {
    size_t n = 0u;
    while (category != NULL) {
        ++n;
        category = (const PianoGenreCategory_t *)category->head.next;
    }
    return n;
}

static size_t genre_count(const PianoGenre_t *genre) {
    size_t n = 0u;
    while (genre != NULL) {
        ++n;
        genre = (const PianoGenre_t *)genre->head.next;
    }
    return n;
}

static void print_categories(const PianoHandle_t *ph) {
    printf("genres.categories=%zu\n", category_count(ph->genreStations));
    size_t ci = 0u;
    for (const PianoGenreCategory_t *category = ph->genreStations; category != NULL;
            category = (const PianoGenreCategory_t *)category->head.next, ++ci) {
        printf("genres.category%zu.name=%s\n", ci,
            category->name != NULL ? category->name : "<null>");
        printf("genres.category%zu.count=%zu\n", ci, genre_count(category->genres));
        size_t gi = 0u;
        for (const PianoGenre_t *genre = category->genres; genre != NULL;
                genre = (const PianoGenre_t *)genre->head.next, ++gi) {
            printf("genres.category%zu.genre%zu.name=%s\n", ci, gi,
                genre->name != NULL ? genre->name : "<null>");
            printf("genres.category%zu.genre%zu.id=%s\n", ci, gi,
                genre->musicId != NULL ? genre->musicId : "<null>");
        }
    }
}

int main(void) {
#ifdef MELODICA_REFERENCE_UPSTREAM
    if (gcry_check_version(NULL) == NULL) return 90;
#endif

    PianoHandle_t ph;
    PianoReturn_t ret = PianoInit(&ph, "partner", "password", "device",
        "abcdefgh", "ijklmnop");
    if (ret != PIANO_RET_OK) return 1;
    ph.user.authToken = copy_string("auth token/?");
    ph.user.listenerId = copy_string("listener-7");
    ph.partner.id = 42u;
    ph.timeOffset = 123;

    PianoStation_t *selected = new_station("station/\"one", 1, 0, 0);
    PianoStation_t *quickmix = new_station("quickmix", 1, 1, 1);
    PianoStation_t *off = new_station("off", 0, 0, 1);
    PianoStation_t *selected_two = new_station("station-two", 1, 0, 1);
    ph.stations = (PianoStation_t *)PianoListAppend(NULL, &selected->head);
    ph.stations = (PianoStation_t *)PianoListAppendP(ph.stations, quickmix);
    ph.stations = (PianoStation_t *)PianoListAppendP(ph.stations, off);
    ph.stations = (PianoStation_t *)PianoListAppendP(ph.stations, selected_two);

    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_SET_QUICKMIX);
    print_request("quickmix", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("quickmix.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_GET_GENRE_STATIONS);
    print_request("genres", ret, &req);
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"categories\":["
        "{\"categoryName\":\"Alt \\u2603\",\"stations\":["
        "{\"stationName\":\"Indie / \\\"\",\"stationToken\":\"genre/1\"},"
        "{\"stationName\":\"Noise\",\"stationToken\":\"genre-2\"}]},"
        "{\"categoryName\":\"Empty\",\"stations\":[]}]}}";
    ret = PianoResponse(&ph, &req);
    printf("genres.response=%d\n", (int)ret);
    print_categories(&ph);
    req.responseData = (char *)"{\"stat\":\"ok\"}";
    ret = PianoResponse(&ph, &req);
    printf("genres.missing-result.response=%d\n", (int)ret);
    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("genres.error=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.data = selected;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_TRANSFORM_STATION);
    print_request("transform", ret, &req);
    printf("transform.creator.before=%d\n", !!selected->isCreator);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("transform.response=%d\n", (int)ret);
    printf("transform.creator.after=%d\n", !!selected->isCreator);
    PianoDestroyRequest(&req);

    PianoDestroy(&ph);
    return 0;
}
