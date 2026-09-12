#include "piano.h"
#include "crypt.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

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
    assert(PianoInit(&handle, "par\"tner", "sec\nret", "dev\\ice",
            "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    assert(handle.partner.in != NULL);
    assert(handle.partner.out != NULL);
    assert(strcmp(handle.partner.user, "par\"tner") == 0);
    assert(strcmp(PianoErrorToStr(PIANO_RET_INVALID_LOGIN), "Wrong email address or password.") == 0);

    PianoRequestDataLogin_t login = {0};
    login.step = 0;
    PianoRequest_t loginRequest = {0};
    loginRequest.data = &login;
    assert(PianoRequest(&handle, &loginRequest, PIANO_REQUEST_LOGIN) == PIANO_RET_OK);
    assert(loginRequest.type == PIANO_REQUEST_LOGIN);
    assert(loginRequest.secure);
    assert(strcmp(loginRequest.urlPath,
            "/services/json/?method=auth.partnerLogin") == 0);
    assert(strcmp(loginRequest.postData,
            "{\"username\":\"par\\\"tner\",\"password\":\"sec\\nret\","
            "\"deviceModel\":\"dev\\\\ice\",\"version\":\"5\",\"includeUrls\":true}") == 0);
    PianoDestroyRequest(&loginRequest);

    handle.partner.authToken = duptext("tok en/?");
    handle.partner.id = 42u;
    handle.timeOffset = (int)(time(NULL) - (time_t)12345);
    login.step = 1;
    login.user = (char *)"user\"name";
    login.password = (char *)"pass\\word";
    memset(&loginRequest, 0, sizeof(loginRequest));
    loginRequest.data = &login;
    assert(PianoRequest(&handle, &loginRequest, PIANO_REQUEST_LOGIN) == PIANO_RET_OK);
    assert(loginRequest.secure);
    assert(strcmp(loginRequest.urlPath,
            "/services/json/?method=auth.userLogin&auth_token=tok%20en%2F%3F&partner_id=42") == 0);
    assert(strstr(loginRequest.postData, "user") == NULL);

    size_t decryptedSize = 0u;
    char *decrypted = melodica_piano_decrypt_string(
            (const MelodicaBlowfish *)handle.partner.out,
            loginRequest.postData, &decryptedSize);
    assert(decrypted != NULL);
    assert(decryptedSize >= strlen(decrypted));
    assert(strstr(decrypted, "\"loginType\":\"user\"") != NULL);
    assert(strstr(decrypted, "\"username\":\"user\\\"name\"") != NULL);
    assert(strstr(decrypted, "\"password\":\"pass\\\\word\"") != NULL);
    assert(strstr(decrypted, "\"partnerAuthToken\":\"tok en/?\"") != NULL);
    assert(strstr(decrypted, "\"syncTime\":12345") != NULL ||
           strstr(decrypted, "\"syncTime\":12346") != NULL);
    free(decrypted);
    PianoDestroyRequest(&loginRequest);

    PianoRequest_t unsupported = {0};
    unsupported.postData = duptext("body");
    unsupported.responseData = (char *)"externally-owned";
    assert(PianoRequest(&handle, &unsupported, PIANO_REQUEST_GET_STATIONS) == PIANO_RET_ERR);
    assert(unsupported.type == PIANO_REQUEST_GET_STATIONS);
    PianoDestroyRequest(&unsupported);
    assert(unsupported.postData == NULL);
    assert(unsupported.responseData == NULL);

    PianoDestroy(&handle);
    assert(handle.partner.user == NULL);
    assert(handle.partner.in == NULL);
    assert(handle.partner.out == NULL);
    return 0;
}
