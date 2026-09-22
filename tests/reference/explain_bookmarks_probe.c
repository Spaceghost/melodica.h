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
    song.trackToken = (char *)"track/\\\"token";

    PianoRequestDataExplain_t explain;
    memset(&explain, 0, sizeof(explain));
    explain.song = &song;

    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &explain;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_EXPLAIN);
    print_request("explain", ret, &req);
    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"explanations\":["
        "{\"focusTraitName\":\"acoustic instrumentation\"},"
        "{\"focusTraitName\":\"vocal harmony\"},"
        "{\"focusTraitName\":\"minor key tonality\"}]}}";
    ret = PianoResponse(&ph, &req);
    printf("explain.response=%d\n", (int)ret);
    printf("explain.text=%s\n", explain.retExplain != NULL ? explain.retExplain : "<null>");
    free(explain.retExplain);
    explain.retExplain = NULL;

    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"explanations\":["
        "{\"focusTraitName\":\"single trait\"}]}}";
    ret = PianoResponse(&ph, &req);
    printf("explain.single.response=%d\n", (int)ret);
    printf("explain.single.text=%s\n",
        explain.retExplain != NULL ? explain.retExplain : "<null>");
    free(explain.retExplain);
    explain.retExplain = NULL;

    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"explanations\":[{},"
        "{\"focusTraitName\":\"late trait\"}]}}";
    ret = PianoResponse(&ph, &req);
    printf("explain.sparse.response=%d\n", (int)ret);
    printf("explain.sparse.text=%s\n",
        explain.retExplain != NULL ? explain.retExplain : "<null>");
    free(explain.retExplain);
    explain.retExplain = NULL;

    explain.retExplain = copy_string("preserved");
    req.responseData = (char *)"{\"stat\":\"ok\"}";
    ret = PianoResponse(&ph, &req);
    printf("explain.missing.response=%d\n", (int)ret);
    printf("explain.missing.text=%s\n", explain.retExplain);
    free(explain.retExplain);
    explain.retExplain = NULL;

    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("explain.error=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.data = &song;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_BOOKMARK_SONG);
    print_request("bookmark.song", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("bookmark.song.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.data = &song;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_BOOKMARK_ARTIST);
    print_request("bookmark.artist", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("bookmark.artist.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    PianoDestroy(&ph);
    return 0;
}
