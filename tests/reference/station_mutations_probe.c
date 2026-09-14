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

static PianoStation_t *new_station(const char *name, const char *id) {
    PianoStation_t *station = (PianoStation_t *)calloc(1u, sizeof(*station));
    assert(station != NULL);
    station->name = copy_string(name);
    station->id = copy_string(id);
    station->isCreator = 1;
    return station;
}

static void print_hex(const char *key, const char *s) {
    printf("%s=", key);
    if (s == NULL) fputs("<null>", stdout);
    else for (; *s != '\0'; ++s) printf("%02x", (unsigned char)*s);
    putchar('\n');
}

static void print_request(const char *label, const PianoReturn_t ret,
        const PianoRequest_t *req) {
    printf("%s.ret=%d secure=%d type=%d\n", label, (int)ret,
        req->secure ? 1 : 0, (int)req->type);
    char key[64];
    (void)snprintf(key, sizeof(key), "%s.url", label);
    print_hex(key, req->urlPath);
    (void)snprintf(key, sizeof(key), "%s.ciphertext", label);
    print_hex(key, req->postData);
}

static size_t station_count(const PianoStation_t *station) {
    size_t count = 0u;
    for (; station != NULL; station = (const PianoStation_t *)station->head.next) ++count;
    return count;
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

    PianoStation_t *rename_station = new_station("Old Name", "rename/1");
    PianoStation_t *delete_station = new_station("Delete Me", "delete/?2");
    PianoStation_t *replace_station = new_station("Old Created", "created-1");
    ph.stations = rename_station;
    rename_station->head.next = &delete_station->head;
    delete_station->head.next = &replace_station->head;

    PianoRequest_t req;
    PianoRequestDataRenameStation_t rename_data;
    memset(&rename_data, 0, sizeof(rename_data));
    rename_data.station = rename_station;
    rename_data.newName = (char *)"Renamed / \"Station\" \\ \001";
    memset(&req, 0, sizeof(req));
    req.data = &rename_data;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_RENAME_STATION);
    assert(ret == PIANO_RET_OK);
    print_request("rename", ret, &req);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.data = delete_station;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_DELETE_STATION);
    assert(ret == PIANO_RET_OK);
    print_request("delete", ret, &req);
    PianoDestroyRequest(&req);

    PianoRequestDataCreateStation_t create_data;
    memset(&create_data, 0, sizeof(create_data));
    create_data.token = (char *)"music /?\"\\\001";
    create_data.type = PIANO_MUSICTYPE_INVALID;
    memset(&req, 0, sizeof(req));
    req.data = &create_data;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_CREATE_STATION);
    assert(ret == PIANO_RET_OK);
    print_request("create.music", ret, &req);
    PianoDestroyRequest(&req);

    create_data.token = (char *)"track-token";
    create_data.type = PIANO_MUSICTYPE_SONG;
    memset(&req, 0, sizeof(req));
    req.data = &create_data;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_CREATE_STATION);
    assert(ret == PIANO_RET_OK);
    print_request("create.song", ret, &req);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_RENAME_STATION;
    req.data = &rename_data;
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_OK);
    printf("rename.response.ret=%d\n", (int)ret);
    print_hex("rename.response.name", rename_station->name);

    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_CREATE_STATION;
    req.data = &create_data;
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"stationName\":\"New \\u2603\","
        "\"stationToken\":\"created-1\",\"isShared\":false,\"isQuickMix\":false}}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_OK);
    PianoStation_t *created = PianoFindStationById(ph.stations, "created-1");
    assert(created != NULL);
    printf("create.response.ret=%d count=%zu creator=%d quickmix=%d\n",
        (int)ret, station_count(ph.stations), !!created->isCreator, !!created->isQuickMix);
    print_hex("create.response.name", created->name);

    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_DELETE_STATION;
    req.data = delete_station;
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_OK);
    printf("delete.response.ret=%d count=%zu present=%d\n", (int)ret,
        station_count(ph.stations), PianoFindStationById(ph.stations, "delete/?2") != NULL);

    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_RENAME_STATION;
    req.data = &rename_data;
    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    assert(ret == PIANO_RET_P_INVALID_AUTH_TOKEN);
    printf("error.ret=%d\n", (int)ret);

    PianoDestroy(&ph);
    puts("station mutation probe: rename/delete/create request and response behavior passed");
    return 0;
}
