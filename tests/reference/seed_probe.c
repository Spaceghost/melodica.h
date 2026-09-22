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

    PianoStation_t station;
    memset(&station, 0, sizeof(station));
    station.id = (char *)"station/7";
    station.seedId = (char *)"station-seed\\\"/3";

    PianoSong_t song;
    memset(&song, 0, sizeof(song));
    song.seedId = (char *)"song-seed\\\"/1";
    song.feedbackId = (char *)"feedback\\\"/9";

    PianoArtist_t artist;
    memset(&artist, 0, sizeof(artist));
    artist.seedId = (char *)"artist-seed\\\"/2";

    PianoRequestDataAddSeed_t add;
    memset(&add, 0, sizeof(add));
    add.station = &station;
    add.musicId = (char *)"music\\\"/42";

    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &add;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_ADD_SEED);
    print_request("seed.add", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("seed.add.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&req, 0, sizeof(req));
    req.data = &song;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_DELETE_FEEDBACK);
    print_request("feedback.delete", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("feedback.delete.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    PianoRequestDataDeleteSeed_t del;
    memset(&del, 0, sizeof(del));
    del.song = &song;
    memset(&req, 0, sizeof(req));
    req.data = &del;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_DELETE_SEED);
    print_request("seed.delete.song", ret, &req);
    req.responseData = (char *)"{\"stat\":\"ok\",\"result\":{}}";
    ret = PianoResponse(&ph, &req);
    printf("seed.delete.song.response=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&del, 0, sizeof(del));
    del.artist = &artist;
    memset(&req, 0, sizeof(req));
    req.data = &del;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_DELETE_SEED);
    print_request("seed.delete.artist", ret, &req);
    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("seed.delete.artist.error=%d\n", (int)ret);
    PianoDestroyRequest(&req);

    memset(&del, 0, sizeof(del));
    del.station = &station;
    memset(&req, 0, sizeof(req));
    req.data = &del;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_DELETE_SEED);
    print_request("seed.delete.station", ret, &req);
    PianoDestroyRequest(&req);

    memset(&del, 0, sizeof(del));
    del.song = &song;
    del.artist = &artist;
    del.station = &station;
    memset(&req, 0, sizeof(req));
    req.data = &del;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_DELETE_SEED);
    print_request("seed.delete.precedence", ret, &req);
    PianoDestroyRequest(&req);

    PianoDestroy(&ph);
    return 0;
}
