#include "piano.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

static char *piano_dup(const char *s) {
    if (s == NULL) return NULL;
    const size_t n = strlen(s) + 1u;
    char *copy = (char *)malloc(n);
    if (copy != NULL) memcpy(copy, s, n);
    return copy;
}

size_t PianoListCount(const PianoListHead_t *l) {
    assert(l != NULL);
    size_t count = 0u;
    for (const PianoListHead_t *cur = l; cur != NULL; cur = cur->next) ++count;
    return count;
}

void *PianoListAppend(PianoListHead_t *l, PianoListHead_t *e) {
    assert(e != NULL);
    assert(e->next == NULL);
    if (l == NULL) return e;
    PianoListHead_t *cur = l;
    while (cur->next != NULL) cur = cur->next;
    cur->next = e;
    return l;
}

void *PianoListPrepend(PianoListHead_t *l, PianoListHead_t *e) {
    assert(e != NULL);
    assert(e->next == NULL);
    e->next = l;
    return e;
}

void *PianoListDelete(PianoListHead_t *l, PianoListHead_t *e) {
    assert(l != NULL);
    assert(e != NULL);
    PianoListHead_t *first = l, *cur = l, *prev = NULL;
    while (cur != NULL) {
        if (cur == e) {
            if (prev != NULL) prev->next = cur->next;
            else first = cur->next;
            break;
        }
        prev = cur;
        cur = cur->next;
    }
    return first;
}

void *PianoListGet(PianoListHead_t *l, size_t n) {
    for (PianoListHead_t *cur = l; cur != NULL; cur = cur->next) {
        if (n == 0u) return cur;
        --n;
    }
    return NULL;
}

static void destroy_artists(PianoArtist_t *artists) {
    while (artists != NULL) {
        PianoArtist_t *next = (PianoArtist_t *)artists->head.next;
        free(artists->name); free(artists->musicId); free(artists->seedId);
        free(artists);
        artists = next;
    }
}

static void destroy_station(PianoStation_t *station) {
    free(station->name); free(station->id); free(station->seedId);
    memset(station, 0, sizeof(*station));
}

static void destroy_stations(PianoStation_t *stations) {
    while (stations != NULL) {
        PianoStation_t *next = (PianoStation_t *)stations->head.next;
        destroy_station(stations);
        free(stations);
        stations = next;
    }
}

static void destroy_genres(PianoGenre_t *genres) {
    while (genres != NULL) {
        PianoGenre_t *next = (PianoGenre_t *)genres->head.next;
        free(genres->name); free(genres->musicId); free(genres);
        genres = next;
    }
}

void PianoDestroyPlaylist(PianoSong_t *playlist) {
    while (playlist != NULL) {
        PianoSong_t *next = (PianoSong_t *)playlist->head.next;
        free(playlist->audioUrl); free(playlist->coverArt); free(playlist->artist);
        free(playlist->musicId); free(playlist->title); free(playlist->stationId);
        free(playlist->album); free(playlist->feedbackId); free(playlist->seedId);
        free(playlist->detailUrl); free(playlist->trackToken);
        free(playlist);
        playlist = next;
    }
}

void PianoDestroySearchResult(PianoSearchResult_t *result) {
    if (result == NULL) return;
    destroy_artists(result->artists);
    PianoDestroyPlaylist(result->songs);
    result->artists = NULL;
    result->songs = NULL;
}

void PianoDestroyStationInfo(PianoStationInfo_t *info) {
    if (info == NULL) return;
    PianoDestroyPlaylist(info->feedback);
    PianoDestroyPlaylist(info->songSeeds);
    destroy_artists(info->artistSeeds);
    destroy_stations(info->stationSeeds);
    memset(info, 0, sizeof(*info));
}

void PianoDestroyStationMode(PianoStationMode_t *modes) {
    while (modes != NULL) {
        PianoStationMode_t *next = (PianoStationMode_t *)modes->head.next;
        free(modes->name); free(modes->description); free(modes);
        modes = next;
    }
}

PianoReturn_t PianoInit(PianoHandle_t *ph, const char *partnerUser,
        const char *partnerPassword, const char *device,
        const char *inkey, const char *outkey) {
    (void)inkey;
    (void)outkey;
    if (ph == NULL) return PIANO_RET_ERR;
    memset(ph, 0, sizeof(*ph));
    ph->partner.user = piano_dup(partnerUser);
    ph->partner.password = piano_dup(partnerPassword);
    ph->partner.device = piano_dup(device);
    if ((partnerUser != NULL && ph->partner.user == NULL) ||
        (partnerPassword != NULL && ph->partner.password == NULL) ||
        (device != NULL && ph->partner.device == NULL)) {
        PianoDestroy(ph);
        return PIANO_RET_OUT_OF_MEMORY;
    }
    return PIANO_RET_OK;
}

void PianoDestroy(PianoHandle_t *ph) {
    if (ph == NULL) return;
    free(ph->user.authToken); free(ph->user.listenerId);
    destroy_stations(ph->stations);
    free(ph->partner.user); free(ph->partner.password); free(ph->partner.device);
    free(ph->partner.authToken);
    PianoGenreCategory_t *category = ph->genreStations;
    while (category != NULL) {
        PianoGenreCategory_t *next = (PianoGenreCategory_t *)category->head.next;
        destroy_genres(category->genres);
        free(category->name);
        free(category);
        category = next;
    }
    memset(ph, 0, sizeof(*ph));
}

void PianoDestroyRequest(PianoRequest_t *req) {
    if (req == NULL) return;
    free(req->postData);
    memset(req, 0, sizeof(*req));
}

PianoReturn_t PianoRequest(PianoHandle_t *ph, PianoRequest_t *req,
        const PianoRequestType_t type) {
    (void)ph;
    if (req == NULL) return PIANO_RET_ERR;
    req->type = type;
    /* RPC/request JSON construction is intentionally not faked. */
    return PIANO_RET_ERR;
}

PianoReturn_t PianoResponse(PianoHandle_t *ph, PianoRequest_t *req) {
    (void)ph;
    (void)req;
    /* Response parsing is the next compatibility milestone. */
    return PIANO_RET_INVALID_RESPONSE;
}

PianoStation_t *PianoFindStationById(PianoStation_t *stations, const char *searchStation) {
    assert(stations != NULL);
    if (searchStation == NULL) return NULL;
    for (PianoStation_t *cur = stations; cur != NULL; cur = (PianoStation_t *)cur->head.next) {
        if (strcmp(cur->id, searchStation) == 0) return cur;
    }
    return NULL;
}

const char *PianoErrorToStr(const PianoReturn_t ret) {
    switch (ret) {
        case PIANO_RET_OK: return "Everything is fine :)";
        case PIANO_RET_ERR: return "Unknown.";
        case PIANO_RET_INVALID_RESPONSE: return "Invalid response.";
        case PIANO_RET_CONTINUE_REQUEST: return "Fix your program.";
        case PIANO_RET_OUT_OF_MEMORY: return "Out of memory.";
        case PIANO_RET_INVALID_LOGIN: return "Wrong email address or password.";
        case PIANO_RET_QUALITY_UNAVAILABLE: return "Selected audio quality is not available.";
        case PIANO_RET_GCRY_ERR: return "libgcrypt initialization failed.";
        case PIANO_RET_P_INTERNAL: return "Internal error.";
        case PIANO_RET_P_CALL_NOT_ALLOWED: return "Call not allowed.";
        case PIANO_RET_P_INVALID_AUTH_TOKEN: return "Invalid auth token.";
        case PIANO_RET_P_MAINTENANCE_MODE: return "Maintenance mode.";
        case PIANO_RET_P_MAX_STATIONS_REACHED: return "Max number of stations reached.";
        case PIANO_RET_P_READ_ONLY_MODE: return "Read only mode. Try again later.";
        case PIANO_RET_P_STATION_DOES_NOT_EXIST: return "Station does not exist.";
        case PIANO_RET_P_INVALID_PARTNER_LOGIN: return "Invalid partner login.";
        case PIANO_RET_P_LICENSING_RESTRICTIONS:
            return "Pandora is not available in your country. Set up a control proxy (see manpage).";
        case PIANO_RET_P_PARTNER_NOT_AUTHORIZED: return "Invalid partner credentials.";
        case PIANO_RET_P_LISTENER_NOT_AUTHORIZED: return "Listener not authorized.";
        case PIANO_RET_P_RATE_LIMIT: return "Access denied. Try again later.";
        default: return "No error message available.";
    }
}
