#include "piano.h"
#include "blowfish.h"
#include "crypt.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static char *piano_dup(const char *s) {
    if (s == NULL) return NULL;
    const size_t n = strlen(s) + 1u;
    char *copy = (char *)malloc(n);
    if (copy != NULL) memcpy(copy, s, n);
    return copy;
}

static char piano_hex_upper(const unsigned char n) {
    return (char)(n < 10u ? '0' + (int)n : 'A' + (int)n - 10);
}

static int piano_url_unreserved(const unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
}

static char *piano_url_encode(const char *s) {
    if (s == NULL) return NULL;
    size_t needed = 0u;
    for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; ++p) {
        needed += piano_url_unreserved(*p) ? 1u : 3u;
    }
    char *out = (char *)malloc(needed + 1u);
    if (out == NULL) return NULL;
    size_t n = 0u;
    for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; ++p) {
        if (piano_url_unreserved(*p)) {
            out[n++] = (char)*p;
        } else {
            out[n++] = '%';
            out[n++] = piano_hex_upper((unsigned char)(*p >> 4u));
            out[n++] = piano_hex_upper((unsigned char)(*p & 0x0fu));
        }
    }
    out[n] = '\0';
    return out;
}

static char piano_hex(const unsigned char n) {
    return piano_hex_upper(n);
}

static size_t piano_json_escaped_size(const char *s) {
    size_t n = 0u;
    for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; ++p) {
        switch (*p) {
            case '"': case '\\': case '\b': case '\f': case '\n': case '\r': case '\t':
                n += 2u;
                break;
            default:
                n += *p < 0x20u ? 6u : 1u;
                break;
        }
    }
    return n;
}

static char *piano_json_write_escaped(char *out, const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; ++p) {
        const unsigned char c = *p;
        switch (c) {
            case '"': *out++ = '\\'; *out++ = '"'; break;
            case '\\': *out++ = '\\'; *out++ = '\\'; break;
            case '\b': *out++ = '\\'; *out++ = 'b'; break;
            case '\f': *out++ = '\\'; *out++ = 'f'; break;
            case '\n': *out++ = '\\'; *out++ = 'n'; break;
            case '\r': *out++ = '\\'; *out++ = 'r'; break;
            case '\t': *out++ = '\\'; *out++ = 't'; break;
            default:
                if (c < 0x20u) {
                    *out++ = '\\'; *out++ = 'u'; *out++ = '0'; *out++ = '0';
                    *out++ = piano_hex((unsigned char)(c >> 4u));
                    *out++ = piano_hex((unsigned char)(c & 0x0fu));
                } else {
                    *out++ = (char)c;
                }
                break;
        }
    }
    return out;
}

static char *piano_copy_literal(char *out, const char *literal) {
    const size_t n = strlen(literal);
    memcpy(out, literal, n);
    return out + n;
}

static char *piano_partner_login_json(const PianoPartner_t *partner) {
    static const char a[] = "{\"username\":\"";
    static const char b[] = "\",\"password\":\"";
    static const char c[] = "\",\"deviceModel\":\"";
    static const char d[] = "\",\"version\":\"5\",\"includeUrls\":true}";

    if (partner == NULL || partner->user == NULL ||
            partner->password == NULL || partner->device == NULL) return NULL;

    const size_t len = (sizeof(a) - 1u) + piano_json_escaped_size(partner->user) +
        (sizeof(b) - 1u) + piano_json_escaped_size(partner->password) +
        (sizeof(c) - 1u) + piano_json_escaped_size(partner->device) +
        (sizeof(d) - 1u);
    char *json = (char *)malloc(len + 1u);
    if (json == NULL) return NULL;

    char *out = json;
    out = piano_copy_literal(out, a);
    out = piano_json_write_escaped(out, partner->user);
    out = piano_copy_literal(out, b);
    out = piano_json_write_escaped(out, partner->password);
    out = piano_copy_literal(out, c);
    out = piano_json_write_escaped(out, partner->device);
    out = piano_copy_literal(out, d);
    *out = '\0';
    assert((size_t)(out - json) == len);
    return json;
}

static char *piano_user_login_json(const PianoHandle_t *ph,
        const PianoRequestDataLogin_t *login, const long timestamp) {
    static const char a[] = "{\"loginType\":\"user\",\"username\":\"";
    static const char b[] = "\",\"password\":\"";
    static const char c[] = "\",\"partnerAuthToken\":\"";
    static const char d[] = "\",\"syncTime\":";
    if (ph == NULL || login == NULL || login->user == NULL || login->password == NULL ||
            ph->partner.authToken == NULL) return NULL;

    char number[32];
    const int number_len = snprintf(number, sizeof(number), "%ld", timestamp);
    if (number_len < 0 || (size_t)number_len >= sizeof(number)) return NULL;

    const size_t len = (sizeof(a) - 1u) + piano_json_escaped_size(login->user) +
        (sizeof(b) - 1u) + piano_json_escaped_size(login->password) +
        (sizeof(c) - 1u) + piano_json_escaped_size(ph->partner.authToken) +
        (sizeof(d) - 1u) + (size_t)number_len + 1u;
    char *json = (char *)malloc(len + 1u);
    if (json == NULL) return NULL;
    char *out = json;
    out = piano_copy_literal(out, a);
    out = piano_json_write_escaped(out, login->user);
    out = piano_copy_literal(out, b);
    out = piano_json_write_escaped(out, login->password);
    out = piano_copy_literal(out, c);
    out = piano_json_write_escaped(out, ph->partner.authToken);
    out = piano_copy_literal(out, d);
    out = piano_copy_literal(out, number);
    *out++ = '}';
    *out = '\0';
    assert((size_t)(out - json) == len);
    return json;
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

static void destroy_cipher(PianoCipherHandle_t *handle) {
    if (handle == NULL || *handle == NULL) return;
    MelodicaBlowfish *ctx = (MelodicaBlowfish *)*handle;
    melodica_blowfish_clear(ctx);
    free(ctx);
    *handle = NULL;
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
    if (inkey == NULL || outkey == NULL) {
        PianoDestroy(ph);
        return PIANO_RET_GCRY_ERR;
    }

    MelodicaBlowfish *incoming = (MelodicaBlowfish *)malloc(sizeof(*incoming));
    MelodicaBlowfish *outgoing = (MelodicaBlowfish *)malloc(sizeof(*outgoing));
    if (incoming == NULL || outgoing == NULL) {
        free(incoming);
        free(outgoing);
        PianoDestroy(ph);
        return PIANO_RET_OUT_OF_MEMORY;
    }
    if (!melodica_blowfish_init(incoming, inkey, strlen(inkey)) ||
            !melodica_blowfish_init(outgoing, outkey, strlen(outkey))) {
        melodica_blowfish_clear(incoming);
        melodica_blowfish_clear(outgoing);
        free(incoming);
        free(outgoing);
        PianoDestroy(ph);
        return PIANO_RET_GCRY_ERR;
    }
    ph->partner.in = incoming;
    ph->partner.out = outgoing;
    return PIANO_RET_OK;
}

void PianoDestroy(PianoHandle_t *ph) {
    if (ph == NULL) return;
    free(ph->user.authToken); free(ph->user.listenerId);
    destroy_stations(ph->stations);
    free(ph->partner.user); free(ph->partner.password); free(ph->partner.device);
    free(ph->partner.authToken);
    destroy_cipher(&ph->partner.in);
    destroy_cipher(&ph->partner.out);
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
    if (req == NULL) return PIANO_RET_ERR;
    req->type = type;
    req->secure = false;

    if (type == PIANO_REQUEST_LOGIN && ph != NULL && req->data != NULL) {
        PianoRequestDataLogin_t *login = (PianoRequestDataLogin_t *)req->data;
        if (login->step == 0u) {
            char *body = piano_partner_login_json(&ph->partner);
            if (body == NULL) {
                return (ph->partner.user == NULL || ph->partner.password == NULL ||
                        ph->partner.device == NULL) ? PIANO_RET_ERR : PIANO_RET_OUT_OF_MEMORY;
            }
            const int written = snprintf(req->urlPath, sizeof(req->urlPath),
                    PIANO_RPC_PATH "method=auth.partnerLogin");
            if (written < 0 || (size_t)written >= sizeof(req->urlPath)) {
                free(body);
                return PIANO_RET_ERR;
            }
            free(req->postData);
            req->postData = body;
            req->secure = true;
            return PIANO_RET_OK;
        }
        if (login->step == 1u) {
            const long timestamp = (long)time(NULL) - (long)ph->timeOffset;
            char *json = piano_user_login_json(ph, login, timestamp);
            char *escaped = piano_url_encode(ph->partner.authToken);
            if (json == NULL || escaped == NULL) {
                free(json);
                free(escaped);
                return PIANO_RET_OUT_OF_MEMORY;
            }
            const int written = snprintf(req->urlPath, sizeof(req->urlPath),
                    PIANO_RPC_PATH "method=auth.userLogin&auth_token=%s&partner_id=%u",
                    escaped, ph->partner.id);
            free(escaped);
            if (written < 0 || (size_t)written >= sizeof(req->urlPath)) {
                free(json);
                return PIANO_RET_ERR;
            }
            char *encrypted = melodica_piano_encrypt_string(
                    (const MelodicaBlowfish *)ph->partner.out, json);
            free(json);
            if (encrypted == NULL) return PIANO_RET_OUT_OF_MEMORY;
            free(req->postData);
            req->postData = encrypted;
            req->secure = true;
            return PIANO_RET_OK;
        }
    }

    /* Other authenticated requests are deliberately still explicit failures. */
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
