/* Independent json-c wire oracle, test-only dependency. */
#include "piano.h"
#include "crypt.h"
#include <json-c/json.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

time_t time(time_t *out) {
    time_t now = (time_t)1700000000;
    if (out != NULL) *out = now;
    return now;
}

int main(void) {
    PianoHandle_t ph;
    assert(PianoInit(&ph, "partner", "password", "device", "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    char text[256];
    for (unsigned i = 1; i <= 255; ++i) text[i-1u] = (char)i;
    text[255] = '\0';
    ph.user.authToken = malloc(sizeof(text)); assert(ph.user.authToken != NULL);
    memcpy(ph.user.authToken, text, sizeof(text));
    ph.user.listenerId = malloc(2u); assert(ph.user.listenerId != NULL);
    strcpy(ph.user.listenerId, "7");
    ph.partner.id = 42; ph.timeOffset = 123;
    PianoStation_t station = {0}; station.id = text;
    PianoRequestDataGetPlaylist_t data = {0}; data.station = &station;
    PianoRequest_t req = {0}; req.data = &data;
    assert(PianoRequest(&ph, &req, PIANO_REQUEST_GET_PLAYLIST) == PIANO_RET_OK);
    assert(req.secure);
    size_t length;
    char *plain = melodica_piano_decrypt_string(ph.partner.out, req.postData, &length);
    assert(plain != NULL);
    json_object *j = json_object_new_object(); assert(j != NULL);
    json_object_object_add(j, "stationToken", json_object_new_string(text));
    json_object_object_add(j, "includeTrackLength", json_object_new_boolean(1));
    json_object_object_add(j, "userAuthToken", json_object_new_string(text));
    json_object_object_add(j, "syncTime", json_object_new_int(1699999877));
    const char *expected = json_object_to_json_string(j);
    assert(strcmp(plain, expected) == 0);
    free(plain); json_object_put(j); PianoDestroyRequest(&req); PianoDestroy(&ph);
    puts("playlist wire: all 255 non-NUL byte values match json-c exactly");
    return 0;
}
