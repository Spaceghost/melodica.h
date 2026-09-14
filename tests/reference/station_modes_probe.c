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

static void print_request(const char *label, const PianoReturn_t ret,
        const PianoRequest_t *req) {
    printf("%s.ret=%d\n", label, (int)ret);
    printf("%s.type=%d\n", label, (int)req->type);
    printf("%s.secure=%d\n", label, req->secure ? 1 : 0);
    printf("%s.url=%s\n", label, req->urlPath);
    printf("%s.post=%s\n", label, req->postData != NULL ? req->postData : "<null>");
}

static void print_modes(const PianoStationMode_t *modes) {
    size_t count = 0u;
    for (const PianoStationMode_t *mode = modes; mode != NULL;
            mode = (const PianoStationMode_t *)mode->head.next) {
        printf("mode.%zu.id=%d\n", count, mode->id);
        printf("mode.%zu.name=%s\n", count,
            mode->name != NULL ? mode->name : "<null>");
        printf("mode.%zu.description=%s\n", count,
            mode->description != NULL ? mode->description : "<null>");
        printf("mode.%zu.algorithmic=%d\n", count, mode->isAlgorithmic ? 1 : 0);
        printf("mode.%zu.takeover=%d\n", count, mode->isTakeover ? 1 : 0);
        printf("mode.%zu.active=%d\n", count, mode->active ? 1 : 0);
        ++count;
    }
    printf("modes.count=%zu\n", count);
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

    PianoStation_t station;
    memset(&station, 0, sizeof(station));
    station.id = (char *)"station/\"\\";

    PianoRequestDataGetStationModes_t get;
    memset(&get, 0, sizeof(get));
    get.station = &station;
    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &get;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_GET_STATION_MODES);
    print_request("modes.get", ret, &req);
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"currentModeId\":7,\"availableModes\":["
        "{\"modeId\":1,\"modeName\":\"Crowd Faves\",\"modeDescription\":\"Popular\","
        "\"isAlgorithmicMode\":true,\"isTakeoverMode\":false},"
        "{\"modeId\":7,\"modeName\":\"Discovery \\u2603\","
        "\"modeDescription\":\"Deep\\/cuts\",\"isTakeoverMode\":true},"
        "{\"modeName\":\"ignored-without-id\",\"isAlgorithmicMode\":true}]}}";
    ret = PianoResponse(&ph, &req);
    printf("modes.get.response=%d\n", (int)ret);
    print_modes(get.retModes);
    PianoDestroyStationMode(get.retModes);
    get.retModes = NULL;

    req.responseData = (char *)"{\"stat\":\"ok\"}";
    ret = PianoResponse(&ph, &req);
    printf("modes.get.empty.response=%d\n", (int)ret);
    printf("modes.get.empty.count=%d\n", get.retModes == NULL ? 0 : -1);
    PianoDestroyRequest(&req);

    PianoRequestDataSetStationMode_t set;
    memset(&set, 0, sizeof(set));
    set.station = &station;
    set.id = 7u;
    memset(&req, 0, sizeof(req));
    req.data = &set;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_SET_STATION_MODE);
    print_request("modes.set", ret, &req);
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"currentModeId\":7,\"availableModes\":[]}}";
    ret = PianoResponse(&ph, &req);
    printf("modes.set.response=%d\n", (int)ret);
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"currentModeId\":1}}";
    ret = PianoResponse(&ph, &req);
    printf("modes.set.mismatch=%d\n", (int)ret);
    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("modes.set.error=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    PianoDestroy(&ph);
    return 0;
}
