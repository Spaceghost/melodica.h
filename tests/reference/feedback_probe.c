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

    PianoSong_t song;
    memset(&song, 0, sizeof(song));
    song.stationId = (char *)"station/7";
    song.trackToken = (char *)"track\\\"42";

    PianoRequestDataRateSong_t rate;
    memset(&rate, 0, sizeof(rate));
    rate.song = &song;
    rate.rating = PIANO_RATE_LOVE;

    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &rate;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_RATE_SONG);
    print_request("rate.love", ret, &req);
    printf("rate.love.data_restored=%d\n", req.data == &rate ? 1 : 0);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("rate.love.response=%d\n", (int)ret);
    printf("rate.love.rating=%d\n", (int)song.rating);
    PianoDestroyRequest(&req);

    rate.rating = PIANO_RATE_BAN;
    memset(&req, 0, sizeof(req));
    req.data = &rate;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_RATE_SONG);
    print_request("rate.ban", ret, &req);
    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("rate.ban.error=%d\n", (int)ret);
    printf("rate.ban.rating_after_error=%d\n", (int)song.rating);
    PianoDestroyRequest(&req);

    PianoRequestDataAddFeedback_t feedback;
    memset(&feedback, 0, sizeof(feedback));
    feedback.stationId = (char *)"station/7";
    feedback.trackToken = (char *)"track\\\"42";
    feedback.rating = PIANO_RATE_BAN;
    memset(&req, 0, sizeof(req));
    req.data = &feedback;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_ADD_FEEDBACK);
    print_request("feedback.ban", ret, &req);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.data = &song;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_ADD_TIRED_SONG);
    print_request("tired", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("tired.response=%d\n", (int)ret);
    printf("tired.rating=%d\n", (int)song.rating);
    PianoDestroyRequest(&req);

    PianoDestroy(&ph);
    return 0;
}
