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

static size_t song_count(const PianoSong_t *song) {
    size_t n = 0u;
    while (song != NULL) {
        ++n;
        song = (const PianoSong_t *)song->head.next;
    }
    return n;
}

static size_t artist_count(const PianoArtist_t *artist) {
    size_t n = 0u;
    while (artist != NULL) {
        ++n;
        artist = (const PianoArtist_t *)artist->head.next;
    }
    return n;
}

static void print_request(const char *label, const PianoReturn_t ret,
        const PianoRequest_t *req) {
    printf("%s.ret=%d\n", label, (int)ret);
    printf("%s.type=%d\n", label, (int)req->type);
    printf("%s.secure=%d\n", label, req->secure ? 1 : 0);
    printf("%s.url=%s\n", label, req->urlPath);
    printf("%s.post=%s\n", label, req->postData != NULL ? req->postData : "<null>");
}

static void print_song(const char *label, const PianoSong_t *song) {
    printf("%s.title=%s\n", label, song != NULL && song->title != NULL ? song->title : "<null>");
    printf("%s.artist=%s\n", label, song != NULL && song->artist != NULL ? song->artist : "<null>");
    printf("%s.seed=%s\n", label, song != NULL && song->seedId != NULL ? song->seedId : "<null>");
    printf("%s.feedback=%s\n", label,
        song != NULL && song->feedbackId != NULL ? song->feedbackId : "<null>");
    printf("%s.rating=%d\n", label, song != NULL ? (int)song->rating : -1);
    printf("%s.length=%u\n", label, song != NULL ? song->length : 0u);
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
    station.id = (char *)"station/\"7";

    PianoRequestDataGetStationInfo_t data;
    memset(&data, 0, sizeof(data));
    data.station = &station;

    PianoRequest_t req;
    memset(&req, 0, sizeof(req));
    req.data = &data;
    ret = PianoRequest(&ph, &req, PIANO_REQUEST_GET_STATION_INFO);
    print_request("station.info", ret, &req);

    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{"
        "\"music\":{\"songs\":[{\"songName\":\"Seed \\u2603\","
        "\"artistName\":\"Artist A\",\"seedId\":\"song-seed/1\"}],"
        "\"artists\":[{\"artistName\":\"Artist \\u03b1\","
        "\"seedId\":\"artist-seed/2\"}]},"
        "\"feedback\":{\"thumbsUp\":[{\"songName\":\"Loved\","
        "\"artistName\":\"Up Artist\",\"feedbackId\":\"f-up\","
        "\"isPositive\":true,\"trackLength\":123}],"
        "\"thumbsDown\":[{\"songName\":\"Banned\","
        "\"artistName\":\"Down Artist\",\"feedbackId\":\"f-down\","
        "\"isPositive\":false,\"trackLength\":456}]}}}";
    ret = PianoResponse(&ph, &req);
    printf("station.info.response=%d\n", (int)ret);
    printf("station.info.songSeeds=%zu\n", song_count(data.info.songSeeds));
    printf("station.info.artistSeeds=%zu\n", artist_count(data.info.artistSeeds));
    printf("station.info.stationSeeds=%zu\n",
        data.info.stationSeeds == NULL ? 0u : PianoListCountP(data.info.stationSeeds));
    printf("station.info.feedback=%zu\n", song_count(data.info.feedback));
    print_song("station.info.song0", data.info.songSeeds);
    if (data.info.artistSeeds != NULL) {
        printf("station.info.artist0.name=%s\n",
            data.info.artistSeeds->name != NULL ? data.info.artistSeeds->name : "<null>");
        printf("station.info.artist0.seed=%s\n",
            data.info.artistSeeds->seedId != NULL ? data.info.artistSeeds->seedId : "<null>");
    }
    print_song("station.info.feedback0", data.info.feedback);
    print_song("station.info.feedback1", data.info.feedback == NULL ? NULL :
        (PianoSong_t *)data.info.feedback->head.next);

    PianoDestroyStationInfo(&data.info);
    printf("station.info.destroyed=%d\n",
        data.info.songSeeds == NULL && data.info.artistSeeds == NULL &&
        data.info.stationSeeds == NULL && data.info.feedback == NULL ? 1 : 0);

    req.responseData = (char *)
        "{\"stat\":\"ok\",\"result\":{\"music\":{\"songs\":[],\"artists\":[]},"
        "\"feedback\":{\"thumbsUp\":[],\"thumbsDown\":[]}}}";
    ret = PianoResponse(&ph, &req);
    printf("station.info.empty.response=%d\n", (int)ret);
    printf("station.info.empty.songSeeds=%zu\n", song_count(data.info.songSeeds));
    printf("station.info.empty.artistSeeds=%zu\n", artist_count(data.info.artistSeeds));
    printf("station.info.empty.feedback=%zu\n", song_count(data.info.feedback));

    req.responseData = (char *)"{\"stat\":\"fail\",\"code\":1001}";
    ret = PianoResponse(&ph, &req);
    printf("station.info.error=%d\n", (int)ret);

    PianoDestroyStationInfo(&data.info);
    PianoDestroyRequest(&req);
    PianoDestroy(&ph);
    return 0;
}
