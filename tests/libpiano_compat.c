#include "piano.h"
#include "crypt.h"

#include <assert.h>
#include <stdio.h>
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
    login.user = (char *)"user\"name";
    login.password = (char *)"pass\\word";
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

    char *sync = melodica_piano_encrypt_string(
            (const MelodicaBlowfish *)handle.partner.in, "xxxx12345");
    assert(sync != NULL);
    char partnerResponse[512];
    int responseLength = snprintf(partnerResponse, sizeof(partnerResponse),
            "{\"stat\":\"ok\",\"result\":{\"syncTime\":\"%s\","
            "\"partnerAuthToken\":\"partner token/?\",\"partnerId\":42}}", sync);
    free(sync);
    assert(responseLength > 0 && (size_t)responseLength < sizeof(partnerResponse));

    memset(&loginRequest, 0, sizeof(loginRequest));
    login.step = 0;
    loginRequest.type = PIANO_REQUEST_LOGIN;
    loginRequest.data = &login;
    loginRequest.responseData = partnerResponse;
    assert(PianoResponse(&handle, &loginRequest) == PIANO_RET_CONTINUE_REQUEST);
    assert(login.step == 1u);
    assert(handle.partner.id == 42u);
    assert(strcmp(handle.partner.authToken, "partner token/?") == 0);
    assert(labs((long)handle.timeOffset - ((long)time(NULL) - 12345L)) <= 2L);

    assert(PianoRequest(&handle, &loginRequest, PIANO_REQUEST_LOGIN) == PIANO_RET_OK);
    assert(loginRequest.secure);
    assert(strcmp(loginRequest.urlPath,
            "/services/json/?method=auth.userLogin&auth_token=partner%20token%2F%3F&partner_id=42") == 0);
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
    assert(strstr(decrypted, "\"partnerAuthToken\":\"partner token/?\"") != NULL);
    assert(strstr(decrypted, "\"syncTime\":12345") != NULL ||
           strstr(decrypted, "\"syncTime\":12346") != NULL ||
           strstr(decrypted, "\"syncTime\":12347") != NULL);
    free(decrypted);

    loginRequest.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"userId\":\"listener-1\","
        "\"userAuthToken\":\"user-token\"}}";
    assert(PianoResponse(&handle, &loginRequest) == PIANO_RET_OK);
    assert(strcmp(handle.user.listenerId, "listener-1") == 0);
    assert(strcmp(handle.user.authToken, "user-token") == 0);

    loginRequest.responseData = (char *)"{\"stat\":\"fail\",\"code\":1002}";
    assert(PianoResponse(&handle, &loginRequest) == PIANO_RET_INVALID_LOGIN);
    loginRequest.responseData = (char *)"{\"result\":{}}";
    assert(PianoResponse(&handle, &loginRequest) == PIANO_RET_INVALID_RESPONSE);
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
