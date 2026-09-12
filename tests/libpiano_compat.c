#include "piano.h"
#include "crypt.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

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
    assert(strcmp(PianoErrorToStr(PIANO_RET_INVALID_LOGIN),
            "Wrong email address or password.") == 0);

    PianoRequestDataLogin_t login = {0};
    login.step = 0;
    login.user = (char *)"user\"name";
    login.password = (char *)"pass\\word";
    PianoRequest_t request = {0};
    request.data = &login;
    assert(PianoRequest(&handle, &request, PIANO_REQUEST_LOGIN) == PIANO_RET_OK);
    assert(request.type == PIANO_REQUEST_LOGIN);
    assert(request.secure);
    assert(strcmp(request.urlPath,
            "/services/json/?method=auth.partnerLogin") == 0);
    assert(strcmp(request.postData,
            "{ \"username\": \"par\\\"tner\", \"password\": \"sec\\nret\", "
            "\"deviceModel\": \"dev\\\\ice\", \"version\": \"5\", "
            "\"includeUrls\": true }") == 0);
    PianoDestroyRequest(&request);

    char *sync = melodica_piano_encrypt_string(
            (const MelodicaBlowfish *)handle.partner.in, "xxxx12345");
    assert(sync != NULL);
    char partnerResponse[512];
    int responseLength = snprintf(partnerResponse, sizeof(partnerResponse),
            "{\"stat\":\"ok\",\"result\":{\"syncTime\":\"%s\","
            "\"partnerAuthToken\":\"partner token/?\",\"partnerId\":42}}", sync);
    free(sync);
    assert(responseLength > 0 && (size_t)responseLength < sizeof(partnerResponse));

    memset(&request, 0, sizeof(request));
    login.step = 0;
    request.type = PIANO_REQUEST_LOGIN;
    request.data = &login;
    request.responseData = partnerResponse;
    assert(PianoResponse(&handle, &request) == PIANO_RET_CONTINUE_REQUEST);
    assert(login.step == 1u);
    assert(handle.partner.id == 42u);
    assert(strcmp(handle.partner.authToken, "partner token/?") == 0);
    assert(labs((long)handle.timeOffset - ((long)time(NULL) - 12345L)) <= 2L);

    assert(PianoRequest(&handle, &request, PIANO_REQUEST_LOGIN) == PIANO_RET_OK);
    assert(request.secure);
    assert(strcmp(request.urlPath,
            "/services/json/?method=auth.userLogin&auth_token=partner%20token%2F%3F&partner_id=42") == 0);
    assert(strstr(request.postData, "user") == NULL);

    size_t decryptedSize = 0u;
    char *decrypted = melodica_piano_decrypt_string(
            (const MelodicaBlowfish *)handle.partner.out,
            request.postData, &decryptedSize);
    assert(decrypted != NULL);
    assert(decryptedSize >= strlen(decrypted));
    assert(strstr(decrypted, "\"loginType\": \"user\"") != NULL);
    assert(strstr(decrypted, "\"username\": \"user\\\"name\"") != NULL);
    assert(strstr(decrypted, "\"password\": \"pass\\\\word\"") != NULL);
    assert(strstr(decrypted, "\"partnerAuthToken\": \"partner token\\/?\"") != NULL);
    assert(strstr(decrypted, "\"syncTime\": 12345") != NULL ||
           strstr(decrypted, "\"syncTime\": 12346") != NULL ||
           strstr(decrypted, "\"syncTime\": 12347") != NULL);
    free(decrypted);

    request.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"userId\":\"listener-1\","
        "\"userAuthToken\":\"user-token\"}}";
    assert(PianoResponse(&handle, &request) == PIANO_RET_OK);
    assert(strcmp(handle.user.listenerId, "listener-1") == 0);
    assert(strcmp(handle.user.authToken, "user-token") == 0);

    request.responseData = (char *)"{\"stat\":\"fail\",\"code\":1002}";
    assert(PianoResponse(&handle, &request) == PIANO_RET_INVALID_LOGIN);
    request.responseData = (char *)"{\"result\":{}}";
    assert(PianoResponse(&handle, &request) == PIANO_RET_INVALID_RESPONSE);
    PianoDestroyRequest(&request);

    memset(&request, 0, sizeof(request));
    assert(PianoRequest(&handle, &request, PIANO_REQUEST_GET_STATIONS) == PIANO_RET_OK);
    assert(request.type == PIANO_REQUEST_GET_STATIONS);
    assert(!request.secure);
    assert(strcmp(request.urlPath,
            "/services/json/?method=user.getStationList&auth_token=user-token&partner_id=42&user_id=listener-1") == 0);

    decrypted = melodica_piano_decrypt_string(
            (const MelodicaBlowfish *)handle.partner.out,
            request.postData, &decryptedSize);
    assert(decrypted != NULL);
    assert(strstr(decrypted, "{ \"returnAllStations\": true") != NULL);
    assert(strstr(decrypted, "\"userAuthToken\": \"user-token\"") != NULL);
    assert(strstr(decrypted, "\"syncTime\": 12345") != NULL ||
           strstr(decrypted, "\"syncTime\": 12346") != NULL ||
           strstr(decrypted, "\"syncTime\": 12347") != NULL);
    free(decrypted);

    request.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"stations\":["
        "{\"stationName\":\"One\",\"stationToken\":\"1\",\"isShared\":false},"
        "{\"stationName\":\"Shared\",\"stationToken\":\"2\",\"isShared\":true},"
        "{\"stationName\":\"QuickMix\",\"stationToken\":\"mix\","
        "\"isQuickMix\":true,\"quickMixStationIds\":[\"1\"]}]}}";
    assert(PianoResponse(&handle, &request) == PIANO_RET_OK);
    assert(PianoListCountP(handle.stations) == 3u);
    PianoStation_t *one = PianoFindStationById(handle.stations, "1");
    PianoStation_t *shared = PianoFindStationById(handle.stations, "2");
    PianoStation_t *mix = PianoFindStationById(handle.stations, "mix");
    assert(one != NULL && shared != NULL && mix != NULL);
    assert(strcmp(one->name, "One") == 0 && one->isCreator && one->useQuickMix);
    assert(strcmp(shared->name, "Shared") == 0 && !shared->isCreator && !shared->useQuickMix);
    assert(mix->isQuickMix && !mix->useQuickMix);
    PianoDestroyRequest(&request);

    PianoDestroy(&handle);
    assert(handle.partner.user == NULL);
    assert(handle.partner.in == NULL);
    assert(handle.partner.out == NULL);
    return 0;
}
