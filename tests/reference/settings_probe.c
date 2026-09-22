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

    PianoSettings_t settings;
    memset(&settings, 0, sizeof(settings));
    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &settings;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_GET_SETTINGS);
    print_request("settings.get", ret, &req);
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"username\":\"user\\/\\u2603@example.com\","
        "\"isExplicitContentFilterEnabled\":true}}";
    ret = PianoResponse(&ph, &req);
    printf("settings.get.response=%d\n", (int)ret);
    printf("settings.get.username=%s\n", settings.username != NULL ? settings.username : "<null>");
    printf("settings.get.explicit=%d\n", settings.explicitContentFilter ? 1 : 0);
    free(settings.username);
    settings.username = NULL;

    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"username\":\"plain@example.com\"}}";
    ret = PianoResponse(&ph, &req);
    printf("settings.default.response=%d\n", (int)ret);
    printf("settings.default.username=%s\n",
        settings.username != NULL ? settings.username : "<null>");
    printf("settings.default.explicit=%d\n", settings.explicitContentFilter ? 1 : 0);
    free(settings.username);
    settings.username = NULL;
    PianoDestroyRequest(&req);

    PianoRequestDataChangeSettings_t change;
    memset(&change, 0, sizeof(change));
    change.currentUsername = (char *)"old/user@example.com";
    change.currentPassword = (char *)"p\\\"ass\nword";
    change.newUsername = (char *)"new/user@example.com";
    change.newPassword = (char *)"new\tpass";
    change.explicitContentFilter = PIANO_TRUE;
    memset(&req, 0, sizeof(req));
    req.data = &change;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_CHANGE_SETTINGS);
    print_request("settings.change.full", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{\"ignored\":true}}";
    ret = PianoResponse(&ph, &req);
    printf("settings.change.full.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&change, 0, sizeof(change));
    change.currentUsername = (char *)"old@example.com";
    change.currentPassword = (char *)"current-pass";
    change.explicitContentFilter = PIANO_UNDEFINED;
    memset(&req, 0, sizeof(req));
    req.data = &change;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_CHANGE_SETTINGS);
    print_request("settings.change.minimal", ret, &req);
    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("settings.change.error=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    PianoDestroy(&ph);
    return 0;
}
