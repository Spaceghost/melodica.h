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

static void string(const char *text) {
    if (text == NULL) fputs("<null>", stdout);
    else for (; *text != '\0'; ++text) printf("%02x", (unsigned char)*text);
    putchar(' ');
}

/* Blowfish ECB, key "abcdefgh", zero padding: plaintexts "xxxx12345"
 * and "xxxxzero". Fixed bytes keep the probe independent of private helpers. */
#define SYNC_NUMERIC "a0824696b2ab43eb09bfcb374f1710b5"
#define SYNC_NOT_NUMERIC "44c6f1447c4c6968"

static void partner(const char *label, const char *cipher, const char *literal,
        const char *tail) {
    PianoHandle_t ph;
    assert(PianoInit(&ph, "p", "p", "d", "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    PianoRequestDataLogin_t data = {0};
    PianoRequest_t req = {0}; req.type = PIANO_REQUEST_LOGIN; req.data = &data;
    char json[1024];
    if (cipher != NULL) {
        snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{\"syncTime\":\"%s\"%s}}", cipher, tail);
    } else {
        snprintf(json, sizeof(json), "{\"stat\":\"ok\",\"result\":{%s%s}}", literal, tail);
    }
    req.responseData = json;
    const PianoReturn_t ret = PianoResponse(&ph, &req);
    printf("%s ret=%d step=%u id=%u offset=%d token=", label, (int)ret,
        (unsigned)data.step, ph.partner.id, ph.timeOffset);
    string(ph.partner.authToken); putchar('\n');
    PianoDestroy(&ph);
}

int main(void) {
#ifdef MELODICA_REFERENCE_UPSTREAM
    assert(gcry_check_version(NULL) != NULL);
#endif
    partner("normal", SYNC_NUMERIC, NULL, ",\"partnerAuthToken\":\"p\",\"partnerId\":42");
    partner("coerced", SYNC_NUMERIC, NULL, ",\"partnerAuthToken\":true,\"partnerId\":\"-1tail\"");
    partner("missing_auth", SYNC_NUMERIC, NULL, ",\"partnerId\":null");
    partner("missing_id", SYNC_NUMERIC, NULL, ",\"partnerAuthToken\":\"p\"");
    partner("not_numeric", SYNC_NOT_NUMERIC, NULL, ",\"partnerAuthToken\":\"p\",\"partnerId\":42");
    partner("bad_hex", NULL, "\"syncTime\":\"gggggggggggggggg\"", ",\"partnerAuthToken\":\"p\",\"partnerId\":42");
    partner("empty", NULL, "\"syncTime\":\"\"", ",\"partnerAuthToken\":\"p\",\"partnerId\":42");
    partner("missing_sync", NULL, "\"partnerAuthToken\":\"p\",\"partnerId\":42", "");
    PianoHandle_t ph;
    assert(PianoInit(&ph, "p", "p", "d", "abcdefgh", "ijklmnop") == PIANO_RET_OK);
    PianoRequestDataLogin_t data = {0}; data.step = 1u;
    PianoRequest_t req = {0}; req.type = PIANO_REQUEST_LOGIN; req.data = &data;
    static const char *const responses[] = {
        "{\"stat\":\"ok\",\"result\":{\"userId\":7,\"userAuthToken\":[true]}}",
        "{\"stat\":\"ok\",\"result\":{}}", "{\"stat\":\"ok\",\"result\":false}"
    };
    for (size_t i = 0u; i < sizeof(responses)/sizeof(*responses); ++i) {
        req.responseData = (char *)responses[i];
        printf("user.%zu ret=%d ", i, (int)PianoResponse(&ph, &req));
        string(ph.user.listenerId); string(ph.user.authToken); putchar('\n');
    }
    data.step = 42u; req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    printf("unused_step ret=%d\n", (int)PianoResponse(&ph, &req));
    PianoDestroy(&ph);
    return 0;
}
