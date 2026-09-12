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
    char *out = malloc(n);
    if (out == NULL) abort();
    memcpy(out, s, n);
    return out;
}

static void print_request(const char *label, PianoReturn_t ret, const PianoRequest_t *req) {
    printf("%s.ret=%d\n", label, (int)ret);
    printf("%s.secure=%d\n", label, req->secure ? 1 : 0);
    printf("%s.url=%s\n", label, req->urlPath);
    printf("%s.post=%s\n", label, req->postData != NULL ? req->postData : "<null>");
}

int main(void) {
#ifdef MELODICA_REFERENCE_UPSTREAM
    if (gcry_check_version(NULL) == NULL) return 90;
#endif

    PianoHandle_t ph;
    PianoReturn_t ret = PianoInit(&ph,
        "partner-user", "partner-password", "device-model",
        "abcdefgh", "ijklmnop");
    printf("init.ret=%d\n", (int)ret);
    if (ret != PIANO_RET_OK) return 1;

    PianoRequestDataLogin_t login = {0};
    PianoRequest_t req = {0};
    req.data = &login;

    login.step = 0;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_LOGIN);
    print_request("login0", ret, &req);
    PianoDestroyRequest(&req);

    ph.partner.authToken = copy_string("partner token/?");
    ph.partner.id = 42u;
    ph.timeOffset = 123;
    login.step = 1;
    login.user = (char *)"user@example.com";
    login.password = (char *)"p\\ass\"word";
    memset(&req, 0, sizeof(req));
    req.data = &login;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_LOGIN);
    print_request("login1", ret, &req);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.type = PIANO_REQUEST_LOGIN;
    req.data = &login;
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{\"userId\":\"listener-7\",\"userAuthToken\":\"user-token\"}}";
    ret = PianoResponse(&ph, &req);
    printf("login1.response.ret=%d\n", (int)ret);
    printf("login1.response.user=%s\n", ph.user.listenerId != NULL ? ph.user.listenerId : "<null>");
    printf("login1.response.token=%s\n", ph.user.authToken != NULL ? ph.user.authToken : "<null>");

    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1002}";
    ret = PianoResponse(&ph, &req);
    printf("login1.error.ret=%d\n", (int)ret);

    PianoDestroy(&ph);
    return 0;
}
