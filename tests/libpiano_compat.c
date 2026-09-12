#include "piano.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

static char *duptext(const char *s) {
    size_t n = strlen(s) + 1u;
    char *p = (char *)malloc(n);
    assert(p != NULL);
    memcpy(p, s, n);
    return p;
}

int main(void) {
    PianoStation_t a = {0}, b = {0}, c = {0};
    a.id = (char *)"a";
    b.id = (char *)"b";
    c.id = (char *)"c";

    PianoStation_t *stations = (PianoStation_t *)PianoListAppend(NULL, &a.head);
    stations = (PianoStation_t *)PianoListAppendP(stations, &b);
    stations = (PianoStation_t *)PianoListPrependP(stations, &c);
    assert(PianoListCountP(stations) == 3u);
    assert(PianoListGetP(stations, 0u) == &c);
    assert(PianoListGetP(stations, 2u) == &b);
    assert(PianoFindStationById(stations, "b") == &b);
    stations = (PianoStation_t *)PianoListDeleteP(stations, &a);
    assert(PianoListCountP(stations) == 2u);

    PianoHandle_t handle;
    assert(PianoInit(&handle, "partner", "secret", "device", "in", "out") == PIANO_RET_OK);
    assert(strcmp(handle.partner.user, "partner") == 0);
    assert(strcmp(PianoErrorToStr(PIANO_RET_INVALID_LOGIN), "Wrong email address or password.") == 0);
    PianoDestroy(&handle);
    assert(handle.partner.user == NULL);

    PianoRequest_t request = {0};
    request.postData = duptext("body");
    request.responseData = (char *)"externally-owned";
    assert(PianoRequest(NULL, &request, PIANO_REQUEST_GET_STATIONS) == PIANO_RET_ERR);
    assert(request.type == PIANO_REQUEST_GET_STATIONS);
    PianoDestroyRequest(&request);
    assert(request.postData == NULL);
    assert(request.responseData == NULL);

    return 0;
}
