/*
 * melodica-web: C glue between melodica.h's libpiano-compatible API and JS.
 *
 * All libpiano state (partner session, user session, station list, current
 * playlist) lives here in one static PianoHandle_t. JavaScript only moves
 * UTF-8 strings across the boundary:
 *
 *   mw_init()                   -> 0 on success
 *   mw_begin(requestJson)       -> {"ok":true,"urlPath":..,"secure":..,"postData":..}
 *   mw_continue()               -> same shape; re-issues the pending request
 *                                  after mw_finish reported continue:true
 *   mw_finish(responseBody)     -> {"ok":bool,"continue":bool,"status":n,
 *                                   "code":n|null,"error":str|null,"result":..}
 *   mw_free(ptr)                -> frees a string returned by mw_begin/finish
 *   mw_version()                -> static string
 *
 * Audio ads are outside libpiano's API (its playlist parser skips ad items, as
 * upstream does), so they are handled here: a playlist reply also lists each
 * ad item's adToken and position ("ads"), and the actions adMetadata and
 * registerAd build authenticated ad.getAdMetadata / ad.registerAd requests the
 * same way the library builds its own (user auth token in the URL, the body
 * Blowfish-encrypted with the partner key).
 *
 * The browser does the HTTP (via the relay) and the audio.
 */
#include <errno.h>
#include <stdarg.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "piano.h"
#include "json.h"
#include "crypt.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define MW_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define MW_EXPORT
#endif

#define MW_VERSION "0.1.0"

/* Partner credentials: the same Android client identity pianobar ships. */
#define MW_PARTNER_USER "android"
#define MW_PARTNER_PASSWORD "AC7IBG09A3DTSYM4R41UJWL07VLN8JI7"
#define MW_PARTNER_DEVICE "android-generic"
#define MW_PARTNER_INKEY "R=U!LH$O2B#"
#define MW_PARTNER_OUTKEY "6#26FRL$ZWD"

static char *mw_strdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p != NULL) memcpy(p, s, n);
    return p;
}

/* ------------------------------------------------------------------ */
/* Tiny growable string buffer with JSON escaping.                     */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
    int oom;
} mw_buf;

static void buf_init(mw_buf *b) { b->data = NULL; b->len = 0; b->cap = 0; b->oom = 0; }

static int buf_reserve(mw_buf *b, size_t extra) {
    if (b->oom) return 0;
    if (b->len + extra + 1 <= b->cap) return 1;
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + extra + 1) cap *= 2;
    char *n = (char *)realloc(b->data, cap);
    if (n == NULL) { b->oom = 1; return 0; }
    b->data = n;
    b->cap = cap;
    return 1;
}

static void buf_putc(mw_buf *b, char c) {
    if (!buf_reserve(b, 1)) return;
    b->data[b->len++] = c;
    b->data[b->len] = '\0';
}

static void buf_puts(mw_buf *b, const char *s) {
    size_t n = strlen(s);
    if (!buf_reserve(b, n)) return;
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void buf_json_string(mw_buf *b, const char *s) {
    if (s == NULL) { buf_puts(b, "null"); return; }
    buf_putc(b, '"');
    for (; *s; ++s) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
            case '"': buf_puts(b, "\\\""); break;
            case '\\': buf_puts(b, "\\\\"); break;
            case '\n': buf_puts(b, "\\n"); break;
            case '\r': buf_puts(b, "\\r"); break;
            case '\t': buf_puts(b, "\\t"); break;
            case '\b': buf_puts(b, "\\b"); break;
            case '\f': buf_puts(b, "\\f"); break;
            default:
                if (c < 0x20) {
                    char tmp[8];
                    snprintf(tmp, sizeof(tmp), "\\u%04x", (unsigned)c);
                    buf_puts(b, tmp);
                } else {
                    buf_putc(b, (char)c);
                }
        }
    }
    buf_putc(b, '"');
}

static void buf_kv_string(mw_buf *b, const char *key, const char *value) {
    buf_json_string(b, key);
    buf_putc(b, ':');
    buf_json_string(b, value);
}

static void buf_kv_long(mw_buf *b, const char *key, long value) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%ld", value);
    buf_json_string(b, key);
    buf_putc(b, ':');
    buf_puts(b, tmp);
}

static void buf_kv_double(mw_buf *b, const char *key, double value) {
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "%.6g", value);
    buf_json_string(b, key);
    buf_putc(b, ':');
    buf_puts(b, tmp);
}

static void buf_kv_bool(mw_buf *b, const char *key, int value) {
    buf_json_string(b, key);
    buf_putc(b, ':');
    buf_puts(b, value ? "true" : "false");
}

/* Returns the heap string (caller frees via mw_free), or a static OOM reply. */
static char *buf_finish(mw_buf *b) {
    if (b->oom || b->data == NULL) {
        free(b->data);
        return mw_strdup("{\"ok\":false,\"status\":4,\"code\":null,\"error\":\"Out of memory.\"}");
    }
    return b->data;
}

/* ------------------------------------------------------------------ */
/* State                                                               */

typedef enum {
    MW_ACT_NONE = 0,
    MW_ACT_LOGIN,
    MW_ACT_STATIONS,
    MW_ACT_PLAYLIST,
    MW_ACT_RATE,
    MW_ACT_TIRED,
    MW_ACT_EXPLAIN,
    MW_ACT_SEARCH,
    MW_ACT_CREATE_STATION,
    MW_ACT_DELETE_STATION,
    MW_ACT_AD_METADATA,
    MW_ACT_AD_REGISTER,
} mw_action;

static PianoHandle_t g_ph;
static int g_inited = 0;
static PianoSong_t *g_playlist = NULL;   /* last fetched playlist, owned here */

static PianoRequest_t g_req;
static mw_action g_action = MW_ACT_NONE;
static PianoRequestType_t g_type = PIANO_REQUEST_LOGIN;
static int g_pending = 0;                /* a request is between begin and finish */

/* Per-action request data. Only one is live at a time. */
static PianoRequestDataLogin_t g_login;
static PianoRequestDataGetPlaylist_t g_playlist_req;
static PianoRequestDataRateSong_t g_rate;
static PianoRequestDataExplain_t g_explain;
static PianoRequestDataSearch_t g_search;
static PianoRequestDataCreateStation_t g_create;
static PianoSong_t g_tmp_song;           /* stand-in song for rate/tired/explain */
static PianoSong_t *g_target_song = NULL;/* song the feedback applies to */
static char *g_login_user = NULL;
static char *g_login_pass = NULL;
static char *g_search_text = NULL;
static char *g_create_token = NULL;
static PianoAudioQuality_t g_ad_quality = PIANO_AQ_HIGH;

static void free_tmp_song(void) {
    free(g_tmp_song.trackToken);
    free(g_tmp_song.stationId);
    memset(&g_tmp_song, 0, sizeof(g_tmp_song));
}

static void clear_request_state(void) {
    free(g_req.responseData);
    g_req.responseData = NULL;
    PianoDestroyRequest(&g_req);
    free(g_login_user); g_login_user = NULL;
    free(g_login_pass); g_login_pass = NULL;
    free(g_search_text); g_search_text = NULL;
    free(g_create_token); g_create_token = NULL;
    free_tmp_song();
    free(g_explain.retExplain);
    g_target_song = NULL;
    memset(&g_login, 0, sizeof(g_login));
    memset(&g_playlist_req, 0, sizeof(g_playlist_req));
    memset(&g_rate, 0, sizeof(g_rate));
    memset(&g_explain, 0, sizeof(g_explain));
    memset(&g_search, 0, sizeof(g_search));
    memset(&g_create, 0, sizeof(g_create));
    g_action = MW_ACT_NONE;
    g_pending = 0;
}

static void free_stations(void) {
    PianoStation_t *s = g_ph.stations;
    while (s != NULL) {
        PianoStation_t *next = (PianoStation_t *)s->head.next;
        free(s->name); free(s->id); free(s->seedId);
        free(s);
        s = next;
    }
    g_ph.stations = NULL;
}

static PianoSong_t *find_song(const char *trackToken) {
    if (trackToken == NULL) return NULL;
    for (PianoSong_t *s = g_playlist; s != NULL; s = (PianoSong_t *)s->head.next) {
        if (s->trackToken != NULL && strcmp(s->trackToken, trackToken) == 0) return s;
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Serialisers                                                         */

static void emit_station(mw_buf *b, const PianoStation_t *s) {
    buf_putc(b, '{');
    buf_kv_string(b, "id", s->id); buf_putc(b, ',');
    buf_kv_string(b, "name", s->name); buf_putc(b, ',');
    buf_kv_string(b, "seedId", s->seedId); buf_putc(b, ',');
    buf_kv_bool(b, "isCreator", s->isCreator); buf_putc(b, ',');
    buf_kv_bool(b, "isQuickMix", s->isQuickMix); buf_putc(b, ',');
    buf_kv_bool(b, "useQuickMix", s->useQuickMix);
    buf_putc(b, '}');
}

static void emit_stations(mw_buf *b) {
    buf_puts(b, "\"stations\":[");
    int first = 1;
    for (const PianoStation_t *s = g_ph.stations; s != NULL; s = (const PianoStation_t *)s->head.next) {
        if (!first) buf_putc(b, ',');
        first = 0;
        emit_station(b, s);
    }
    buf_putc(b, ']');
}

static const char *format_name(PianoAudioFormat_t f) {
    switch (f) {
        case PIANO_AF_AACPLUS: return "aacplus";
        case PIANO_AF_MP3: return "mp3";
        default: return "unknown";
    }
}

static void emit_song(mw_buf *b, const PianoSong_t *s) {
    buf_putc(b, '{');
    buf_kv_string(b, "title", s->title); buf_putc(b, ',');
    buf_kv_string(b, "artist", s->artist); buf_putc(b, ',');
    buf_kv_string(b, "album", s->album); buf_putc(b, ',');
    buf_kv_string(b, "audioUrl", s->audioUrl); buf_putc(b, ',');
    buf_kv_string(b, "coverArt", s->coverArt); buf_putc(b, ',');
    buf_kv_string(b, "trackToken", s->trackToken); buf_putc(b, ',');
    buf_kv_string(b, "stationId", s->stationId); buf_putc(b, ',');
    buf_kv_string(b, "musicId", s->musicId); buf_putc(b, ',');
    buf_kv_string(b, "detailUrl", s->detailUrl); buf_putc(b, ',');
    buf_kv_long(b, "duration", (long)s->length); buf_putc(b, ',');
    buf_kv_double(b, "fileGain", (double)s->fileGain); buf_putc(b, ',');
    buf_kv_long(b, "rating", (long)s->rating); buf_putc(b, ',');
    buf_kv_string(b, "audioFormat", format_name(s->audioFormat));
    buf_putc(b, '}');
}

static void emit_songs(mw_buf *b, const char *key, const PianoSong_t *list) {
    buf_json_string(b, key);
    buf_puts(b, ":[");
    int first = 1;
    for (const PianoSong_t *s = list; s != NULL; s = (const PianoSong_t *)s->head.next) {
        if (!first) buf_putc(b, ',');
        first = 0;
        emit_song(b, s);
    }
    buf_putc(b, ']');
}

static void emit_artists(mw_buf *b, const PianoArtist_t *list) {
    buf_puts(b, "\"artists\":[");
    int first = 1;
    for (const PianoArtist_t *a = list; a != NULL; a = (const PianoArtist_t *)a->head.next) {
        if (!first) buf_putc(b, ',');
        first = 0;
        buf_putc(b, '{');
        buf_kv_string(b, "name", a->name); buf_putc(b, ',');
        buf_kv_string(b, "musicId", a->musicId); buf_putc(b, ',');
        buf_kv_string(b, "seedId", a->seedId); buf_putc(b, ',');
        buf_kv_long(b, "score", (long)a->score);
        buf_putc(b, '}');
    }
    buf_putc(b, ']');
}

static char *error_reply(PianoReturn_t ret, const char *detail) {
    mw_buf b; buf_init(&b);
    buf_puts(&b, "{\"ok\":false,\"continue\":false,");
    buf_kv_long(&b, "status", (long)ret); buf_putc(&b, ',');
    if (ret >= PIANO_RET_OFFSET) buf_kv_long(&b, "code", (long)ret - PIANO_RET_OFFSET);
    else { buf_puts(&b, "\"code\":null"); }
    buf_putc(&b, ',');
    buf_kv_string(&b, "error", detail != NULL ? detail : PianoErrorToStr(ret));
    buf_putc(&b, '}');
    return buf_finish(&b);
}

static char *request_reply(void) {
    mw_buf b; buf_init(&b);
    buf_puts(&b, "{\"ok\":true,");
    buf_kv_string(&b, "urlPath", g_req.urlPath); buf_putc(&b, ',');
    buf_kv_bool(&b, "secure", g_req.secure); buf_putc(&b, ',');
    buf_kv_string(&b, "postData", g_req.postData != NULL ? g_req.postData : ""); buf_putc(&b, ',');
    buf_kv_long(&b, "type", (long)g_req.type);
    buf_putc(&b, '}');
    return buf_finish(&b);
}

/* ------------------------------------------------------------------ */
/* Request JSON helpers                                                */

static char *json_field(const MelodicaJsonDoc *doc, const char *key) {
    size_t tok = melodica_json_object_get(doc, 0, key);
    if (tok == MELODICA_JSON_NONE || melodica_json_is_null(doc, tok)) return NULL;
    return melodica_json_string_dup(doc, tok);
}

static long json_field_long(const MelodicaJsonDoc *doc, const char *key, long fallback) {
    size_t tok = melodica_json_object_get(doc, 0, key);
    long v = fallback;
    if (tok == MELODICA_JSON_NONE) return fallback;
    if (!melodica_json_long(doc, tok, &v)) {
        /* allow numeric-looking strings */
        char *s = melodica_json_string_dup(doc, tok);
        if (s != NULL) { v = strtol(s, NULL, 10); free(s); } else v = fallback;
    }
    return v;
}

static PianoAudioQuality_t quality_from(const MelodicaJsonDoc *doc) {
    char *q = json_field(doc, "quality");
    PianoAudioQuality_t out = PIANO_AQ_HIGH;
    if (q != NULL) {
        if (strcmp(q, "low") == 0) out = PIANO_AQ_LOW;
        else if (strcmp(q, "medium") == 0) out = PIANO_AQ_MEDIUM;
        else if (strcmp(q, "high") == 0) out = PIANO_AQ_HIGH;
        else {
            long n = strtol(q, NULL, 10);
            if (n >= PIANO_AQ_LOW && n <= PIANO_AQ_HIGH) out = (PianoAudioQuality_t)n;
        }
        free(q);
    }
    return out;
}

/* Resolve the feedback target: a song from the current playlist, or a
 * stand-in built from trackToken (+ stationId). */
static PianoSong_t *resolve_song(const MelodicaJsonDoc *doc) {
    char *token = json_field(doc, "trackToken");
    if (token == NULL) return NULL;
    PianoSong_t *s = find_song(token);
    if (s != NULL) { free(token); return s; }
    free_tmp_song();
    g_tmp_song.trackToken = token;
    g_tmp_song.stationId = json_field(doc, "stationId");
    return &g_tmp_song;
}

/* ------------------------------------------------------------------ */
/* Ads (outside libpiano)                                              */

static void buf_url_encoded(mw_buf *b, const char *s) {
    static const char hex[] = "0123456789ABCDEF";
    for (; *s; ++s) {
        unsigned char c = (unsigned char)*s;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                c == '-' || c == '_' || c == '.' || c == '~') {
            buf_putc(b, (char)c);
        } else {
            buf_putc(b, '%'); buf_putc(b, hex[c >> 4]); buf_putc(b, hex[c & 15]);
        }
    }
}

/* Fill g_req with an authenticated request for `method`; `body` is the JSON
 * object's members without braces, userAuthToken and syncTime are appended. */
static char *ad_request(const char *method, const char *body) {
    if (g_ph.user.authToken == NULL || g_ph.user.listenerId == NULL || g_ph.partner.out == NULL) {
        return error_reply(PIANO_RET_ERR, "Request could not be built (not logged in?).");
    }
    mw_buf url; buf_init(&url);
    buf_puts(&url, "/services/json/?method=");
    buf_puts(&url, method);
    buf_puts(&url, "&auth_token=");
    buf_url_encoded(&url, g_ph.user.authToken);
    char tail[64];
    snprintf(tail, sizeof(tail), "&partner_id=%u&user_id=", g_ph.partner.id);
    buf_puts(&url, tail);
    buf_url_encoded(&url, g_ph.user.listenerId);
    if (url.oom || url.data == NULL || url.len >= sizeof(g_req.urlPath)) {
        free(url.data);
        return error_reply(PIANO_RET_OUT_OF_MEMORY, NULL);
    }
    memcpy(g_req.urlPath, url.data, url.len + 1);
    free(url.data);

    mw_buf json; buf_init(&json);
    buf_putc(&json, '{');
    buf_puts(&json, body);
    buf_putc(&json, ',');
    buf_kv_string(&json, "userAuthToken", g_ph.user.authToken); buf_putc(&json, ',');
    buf_kv_long(&json, "syncTime", (long)(int)((long)time(NULL) - (long)g_ph.timeOffset));
    buf_putc(&json, '}');
    if (json.oom || json.data == NULL) { free(json.data); return error_reply(PIANO_RET_OUT_OF_MEMORY, NULL); }
    char *encrypted = melodica_piano_encrypt_string((const MelodicaBlowfish *)g_ph.partner.out, json.data);
    free(json.data);
    if (encrypted == NULL) return error_reply(PIANO_RET_OUT_OF_MEMORY, NULL);
    free(g_req.postData);
    g_req.postData = encrypted;
    g_req.secure = true;
    g_pending = 1;
    return request_reply();
}

static void emit_json_token_string(mw_buf *b, const MelodicaJsonDoc *doc, size_t obj, const char *key, const char *out) {
    size_t t = obj == MELODICA_JSON_NONE ? MELODICA_JSON_NONE : melodica_json_object_get(doc, obj, key);
    char *v = (t == MELODICA_JSON_NONE || melodica_json_is_null(doc, t)) ? NULL : melodica_json_string_dup(doc, t);
    buf_kv_string(b, out, v);
    free(v);
}

/* The ad items of a getPlaylist answer: [{"adToken":..,"position":n}] where n
 * is the number of songs (items libpiano keeps) before the ad. */
static void emit_playlist_ads(mw_buf *b, const char *body) {
    buf_puts(b, "\"ads\":[");
    MelodicaJsonDoc doc;
    if (body != NULL && melodica_json_parse(&doc, body)) {
        size_t result = melodica_json_object_get(&doc, 0, "result");
        size_t items = result == MELODICA_JSON_NONE ? MELODICA_JSON_NONE : melodica_json_object_get(&doc, result, "items");
        if (items != MELODICA_JSON_NONE && doc.tokens[items].type == MELODICA_JSON_ARRAY) {
            long songs = 0;
            int first = 1;
            for (size_t item = items + 1u; item < doc.count && doc.tokens[item].start < doc.tokens[items].end; ++item) {
                if (doc.tokens[item].parent != items) continue;
                size_t ad = melodica_json_object_get(&doc, item, "adToken");
                if (ad != MELODICA_JSON_NONE && !melodica_json_is_null(&doc, ad)) {
                    char *token = melodica_json_string_dup(&doc, ad);
                    if (token != NULL && token[0] != '\0') {
                        if (!first) buf_putc(b, ',');
                        first = 0;
                        buf_putc(b, '{');
                        buf_kv_string(b, "adToken", token); buf_putc(b, ',');
                        buf_kv_long(b, "position", songs);
                        buf_putc(b, '}');
                    }
                    free(token);
                } else if (melodica_json_object_get(&doc, item, "artistName") != MELODICA_JSON_NONE) {
                    songs += 1;
                }
            }
        }
        melodica_json_destroy(&doc);
    }
    buf_putc(b, ']');
}

/* Finish an ad request from Pandora's plain JSON answer. */
static char *finish_ad(const char *body) {
    MelodicaJsonDoc doc;
    if (!melodica_json_parse(&doc, body)) return error_reply(PIANO_RET_INVALID_RESPONSE, NULL);
    char *stat = json_field(&doc, "stat");
    int ok = stat != NULL && strcmp(stat, "ok") == 0;
    free(stat);
    if (!ok) {
        long code = json_field_long(&doc, "code", -1);
        char *msg = json_field(&doc, "message");
        char *reply = code >= 0 ? error_reply((PianoReturn_t)(PIANO_RET_OFFSET + code), msg) : error_reply(PIANO_RET_ERR, msg);
        free(msg);
        melodica_json_destroy(&doc);
        return reply;
    }
    mw_buf b; buf_init(&b);
    buf_puts(&b, "{\"ok\":true,\"continue\":false,\"status\":1,\"code\":null,\"error\":null,\"result\":{");
    size_t result = melodica_json_object_get(&doc, 0, "result");
    if (g_action == MW_ACT_AD_METADATA) {
        static const char *const qualities[] = {"", "lowQuality", "mediumQuality", "highQuality"};
        size_t map = result == MELODICA_JSON_NONE ? MELODICA_JSON_NONE : melodica_json_object_get(&doc, result, "audioUrlMap");
        size_t q = MELODICA_JSON_NONE;
        /* The asked quality, else the best one there is. */
        if (map != MELODICA_JSON_NONE) {
            q = melodica_json_object_get(&doc, map, qualities[g_ad_quality]);
            for (int i = PIANO_AQ_HIGH; q == MELODICA_JSON_NONE && i >= PIANO_AQ_LOW; --i) q = melodica_json_object_get(&doc, map, qualities[i]);
        }
        emit_json_token_string(&b, &doc, result, "title", "title"); buf_putc(&b, ',');
        emit_json_token_string(&b, &doc, result, "companyName", "companyName"); buf_putc(&b, ',');
        emit_json_token_string(&b, &doc, result, "imageUrl", "imageUrl"); buf_putc(&b, ',');
        emit_json_token_string(&b, &doc, result, "clickThroughUrl", "clickThroughUrl"); buf_putc(&b, ',');
        emit_json_token_string(&b, &doc, q, "audioUrl", "audioUrl"); buf_putc(&b, ',');
        emit_json_token_string(&b, &doc, q, "encoding", "audioFormat"); buf_putc(&b, ',');
        buf_puts(&b, "\"adTrackingTokens\":[");
        size_t toks = result == MELODICA_JSON_NONE ? MELODICA_JSON_NONE : melodica_json_object_get(&doc, result, "adTrackingTokens");
        if (toks != MELODICA_JSON_NONE && doc.tokens[toks].type == MELODICA_JSON_ARRAY) {
            int first = 1;
            for (size_t t = toks + 1u; t < doc.count && doc.tokens[t].start < doc.tokens[toks].end; ++t) {
                if (doc.tokens[t].parent != toks) continue;
                char *v = melodica_json_string_dup(&doc, t);
                if (v != NULL) {
                    if (!first) buf_putc(&b, ',');
                    first = 0;
                    buf_json_string(&b, v);
                }
                free(v);
            }
        }
        buf_putc(&b, ']');
    } else {
        buf_kv_bool(&b, "registered", 1);
    }
    buf_puts(&b, "}}");
    melodica_json_destroy(&doc);
    return buf_finish(&b);
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */

MW_EXPORT const char *mw_version(void) { return MW_VERSION; }

MW_EXPORT int mw_init(void) {
    if (g_inited) {
        clear_request_state();
        PianoDestroyPlaylist(g_playlist);
        g_playlist = NULL;
        PianoDestroy(&g_ph);
        g_inited = 0;
    }
    memset(&g_ph, 0, sizeof(g_ph));
    memset(&g_req, 0, sizeof(g_req));
    PianoReturn_t ret = PianoInit(&g_ph, MW_PARTNER_USER, MW_PARTNER_PASSWORD,
            MW_PARTNER_DEVICE, MW_PARTNER_INKEY, MW_PARTNER_OUTKEY);
    if (ret != PIANO_RET_OK) return (int)ret;
    g_inited = 1;
    return 0;
}

MW_EXPORT void mw_free(char *p) { free(p); }

MW_EXPORT int mw_logged_in(void) {
    return g_inited && g_ph.user.authToken != NULL && g_ph.user.listenerId != NULL;
}

static char *issue(void) {
    void *data = NULL;
    switch (g_action) {
        case MW_ACT_LOGIN: data = &g_login; break;
        case MW_ACT_STATIONS: data = NULL; break;
        case MW_ACT_PLAYLIST: data = &g_playlist_req; break;
        case MW_ACT_RATE: data = &g_rate; break;
        case MW_ACT_TIRED: data = g_target_song; break;
        case MW_ACT_EXPLAIN: data = &g_explain; break;
        case MW_ACT_SEARCH: data = &g_search; break;
        case MW_ACT_CREATE_STATION: data = &g_create; break;
        case MW_ACT_DELETE_STATION: data = g_playlist_req.station; break;
        default: return error_reply(PIANO_RET_ERR, "No request in progress.");
    }
    free(g_req.postData);
    g_req.postData = NULL;
    free(g_req.responseData);
    g_req.responseData = NULL;
    g_req.urlPath[0] = '\0';
    g_req.data = data;
    PianoReturn_t ret = PianoRequest(&g_ph, &g_req, g_type);
    if (ret != PIANO_RET_OK) {
        clear_request_state();
        return error_reply(ret, ret == PIANO_RET_ERR ? "Request could not be built (not logged in?)." : NULL);
    }
    g_pending = 1;
    return request_reply();
}

MW_EXPORT char *mw_begin(const char *requestJson) {
    if (!g_inited) return error_reply(PIANO_RET_ERR, "mw_init() has not been called.");
    clear_request_state();

    MelodicaJsonDoc doc;
    if (requestJson == NULL || !melodica_json_parse(&doc, requestJson)) {
        return error_reply(PIANO_RET_ERR, "Request is not valid JSON.");
    }
    char *action = json_field(&doc, "action");
    char *reply = NULL;

    if (action == NULL) {
        reply = error_reply(PIANO_RET_ERR, "Request has no action.");
    } else if (strcmp(action, "login") == 0) {
        g_login_user = json_field(&doc, "user");
        g_login_pass = json_field(&doc, "password");
        if (g_login_user == NULL || g_login_pass == NULL) {
            reply = error_reply(PIANO_RET_ERR, "login needs user and password.");
        } else {
            g_login.user = g_login_user;
            g_login.password = g_login_pass;
            g_login.step = 0;
            g_action = MW_ACT_LOGIN;
            g_type = PIANO_REQUEST_LOGIN;
        }
    } else if (strcmp(action, "stations") == 0) {
        g_action = MW_ACT_STATIONS;
        g_type = PIANO_REQUEST_GET_STATIONS;
    } else if (strcmp(action, "playlist") == 0) {
        char *id = json_field(&doc, "stationId");
        PianoStation_t *station = (id != NULL && g_ph.stations != NULL) ?
            PianoFindStationById(g_ph.stations, id) : NULL;
        free(id);
        if (station == NULL) {
            reply = error_reply(PIANO_RET_ERR, "Unknown station; fetch the station list first.");
        } else {
            g_playlist_req.station = station;
            g_playlist_req.quality = quality_from(&doc);
            g_playlist_req.retPlaylist = NULL;
            g_action = MW_ACT_PLAYLIST;
            g_type = PIANO_REQUEST_GET_PLAYLIST;
        }
    } else if (strcmp(action, "rate") == 0) {
        PianoSong_t *song = resolve_song(&doc);
        long rating = json_field_long(&doc, "rating", 0);
        char *rs = json_field(&doc, "rating");
        if (rs != NULL) {
            if (strcmp(rs, "love") == 0 || strcmp(rs, "up") == 0) rating = PIANO_RATE_LOVE;
            else if (strcmp(rs, "ban") == 0 || strcmp(rs, "down") == 0) rating = PIANO_RATE_BAN;
            free(rs);
        }
        if (song == NULL) {
            reply = error_reply(PIANO_RET_ERR, "rate needs a trackToken.");
        } else if (rating != PIANO_RATE_LOVE && rating != PIANO_RATE_BAN) {
            reply = error_reply(PIANO_RET_ERR, "rating must be love (1) or ban (2).");
        } else {
            g_target_song = song;
            g_rate.song = song;
            g_rate.rating = (PianoSongRating_t)rating;
            g_action = MW_ACT_RATE;
            g_type = PIANO_REQUEST_RATE_SONG;
        }
    } else if (strcmp(action, "tired") == 0) {
        PianoSong_t *song = resolve_song(&doc);
        if (song == NULL) {
            reply = error_reply(PIANO_RET_ERR, "tired needs a trackToken.");
        } else {
            g_target_song = song;
            g_action = MW_ACT_TIRED;
            g_type = PIANO_REQUEST_ADD_TIRED_SONG;
        }
    } else if (strcmp(action, "explain") == 0) {
        PianoSong_t *song = resolve_song(&doc);
        if (song == NULL) {
            reply = error_reply(PIANO_RET_ERR, "explain needs a trackToken.");
        } else {
            g_target_song = song;
            g_explain.song = song;
            g_explain.retExplain = NULL;
            g_action = MW_ACT_EXPLAIN;
            g_type = PIANO_REQUEST_EXPLAIN;
        }
    } else if (strcmp(action, "search") == 0) {
        g_search_text = json_field(&doc, "query");
        if (g_search_text == NULL) {
            reply = error_reply(PIANO_RET_ERR, "search needs a query.");
        } else {
            memset(&g_search, 0, sizeof(g_search));
            g_search.searchStr = g_search_text;
            g_action = MW_ACT_SEARCH;
            g_type = PIANO_REQUEST_SEARCH;
        }
    } else if (strcmp(action, "createStation") == 0) {
        g_create_token = json_field(&doc, "token");
        char *type = json_field(&doc, "type");
        if (g_create_token == NULL) {
            reply = error_reply(PIANO_RET_ERR, "createStation needs a token (musicId or trackToken).");
        } else {
            g_create.token = g_create_token;
            g_create.type = PIANO_MUSICTYPE_INVALID;   /* musicToken from search */
            if (type != NULL) {
                if (strcmp(type, "song") == 0) g_create.type = PIANO_MUSICTYPE_SONG;
                else if (strcmp(type, "artist") == 0) g_create.type = PIANO_MUSICTYPE_ARTIST;
            }
            g_action = MW_ACT_CREATE_STATION;
            g_type = PIANO_REQUEST_CREATE_STATION;
        }
        free(type);
    } else if (strcmp(action, "deleteStation") == 0) {
        char *id = json_field(&doc, "stationId");
        PianoStation_t *station = (id != NULL && g_ph.stations != NULL) ?
            PianoFindStationById(g_ph.stations, id) : NULL;
        free(id);
        if (station == NULL) {
            reply = error_reply(PIANO_RET_ERR, "Unknown station.");
        } else {
            g_playlist_req.station = station;
            g_action = MW_ACT_DELETE_STATION;
            g_type = PIANO_REQUEST_DELETE_STATION;
        }
    } else if (strcmp(action, "adMetadata") == 0) {
        char *token = json_field(&doc, "adToken");
        if (token == NULL) {
            reply = error_reply(PIANO_RET_ERR, "adMetadata needs an adToken.");
        } else {
            mw_buf body; buf_init(&body);
            buf_kv_string(&body, "adToken", token); buf_putc(&body, ',');
            buf_kv_bool(&body, "returnAdTrackingTokens", 1); buf_putc(&body, ',');
            buf_kv_bool(&body, "supportAudioAds", 1);
            g_ad_quality = quality_from(&doc);
            g_action = MW_ACT_AD_METADATA;
            reply = body.oom ? error_reply(PIANO_RET_OUT_OF_MEMORY, NULL) : ad_request("ad.getAdMetadata", body.data);
            free(body.data);
            free(token);
            if (g_pending) { free(action); melodica_json_destroy(&doc); return reply; }
        }
    } else if (strcmp(action, "registerAd") == 0) {
        char *station = json_field(&doc, "stationId");
        size_t toks = melodica_json_object_get(&doc, 0, "adTrackingTokens");
        if (station == NULL || toks == MELODICA_JSON_NONE || doc.tokens[toks].type != MELODICA_JSON_ARRAY) {
            reply = error_reply(PIANO_RET_ERR, "registerAd needs a stationId and adTrackingTokens.");
        } else {
            mw_buf body; buf_init(&body);
            buf_kv_string(&body, "stationId", station); buf_putc(&body, ',');
            buf_puts(&body, "\"adTrackingTokens\":[");
            int first = 1;
            for (size_t t = toks + 1u; t < doc.count && doc.tokens[t].start < doc.tokens[toks].end; ++t) {
                if (doc.tokens[t].parent != toks) continue;
                char *v = melodica_json_string_dup(&doc, t);
                if (v != NULL) { if (!first) buf_putc(&body, ','); first = 0; buf_json_string(&body, v); }
                free(v);
            }
            buf_putc(&body, ']');
            g_action = MW_ACT_AD_REGISTER;
            reply = body.oom ? error_reply(PIANO_RET_OUT_OF_MEMORY, NULL) : ad_request("ad.registerAd", body.data);
            free(body.data);
            if (g_pending) { free(station); free(action); melodica_json_destroy(&doc); return reply; }
        }
        free(station);
    } else {
        reply = error_reply(PIANO_RET_ERR, "Unknown action.");
    }

    free(action);
    melodica_json_destroy(&doc);
    if (reply != NULL) {
        clear_request_state();
        return reply;
    }
    if (g_action == MW_ACT_STATIONS) free_stations();
    return issue();
}

MW_EXPORT char *mw_continue(void) {
    if (!g_inited) return error_reply(PIANO_RET_ERR, "mw_init() has not been called.");
    if (g_action == MW_ACT_NONE) return error_reply(PIANO_RET_ERR, "Nothing to continue.");
    if (g_action == MW_ACT_AD_METADATA || g_action == MW_ACT_AD_REGISTER) return error_reply(PIANO_RET_ERR, "Nothing to continue.");
    return issue();
}

static const char *g_finish_body = NULL;  /* the response being finished (playlist ads) */

static char *success_reply(int cont) {
    mw_buf b; buf_init(&b);
    buf_puts(&b, "{\"ok\":true,");
    buf_kv_bool(&b, "continue", cont); buf_putc(&b, ',');
    buf_puts(&b, "\"status\":1,\"code\":null,\"error\":null,\"result\":");
    if (cont) {
        buf_puts(&b, "{\"step\":1}");
    } else {
        buf_putc(&b, '{');
        switch (g_action) {
            case MW_ACT_LOGIN:
                buf_kv_string(&b, "userId", g_ph.user.listenerId); buf_putc(&b, ',');
                buf_kv_bool(&b, "loggedIn", g_ph.user.authToken != NULL);
                break;
            case MW_ACT_STATIONS:
            case MW_ACT_CREATE_STATION:
            case MW_ACT_DELETE_STATION:
                emit_stations(&b);
                break;
            case MW_ACT_PLAYLIST:
                PianoDestroyPlaylist(g_playlist);
                g_playlist = g_playlist_req.retPlaylist;
                g_playlist_req.retPlaylist = NULL;
                emit_songs(&b, "songs", g_playlist); buf_putc(&b, ',');
                emit_playlist_ads(&b, g_finish_body);
                break;
            case MW_ACT_RATE:
                buf_kv_long(&b, "rating", (long)(g_target_song != NULL ? g_target_song->rating : 0));
                break;
            case MW_ACT_TIRED:
                buf_kv_long(&b, "rating", (long)PIANO_RATE_TIRED);
                break;
            case MW_ACT_EXPLAIN:
                buf_kv_string(&b, "explanation", g_explain.retExplain);
                free(g_explain.retExplain);
                g_explain.retExplain = NULL;
                break;
            case MW_ACT_SEARCH:
                emit_artists(&b, g_search.searchResult.artists); buf_putc(&b, ',');
                emit_songs(&b, "songs", g_search.searchResult.songs);
                PianoDestroySearchResult(&g_search.searchResult);
                memset(&g_search.searchResult, 0, sizeof(g_search.searchResult));
                break;
            default:
                break;
        }
        buf_putc(&b, '}');
    }
    buf_putc(&b, '}');
    return buf_finish(&b);
}

MW_EXPORT char *mw_finish(const char *responseBody) {
    if (!g_inited) return error_reply(PIANO_RET_ERR, "mw_init() has not been called.");
    if (!g_pending) return error_reply(PIANO_RET_ERR, "No request in progress.");
    if (responseBody == NULL) {
        clear_request_state();
        return error_reply(PIANO_RET_INVALID_RESPONSE, "Empty response.");
    }
    if (g_action == MW_ACT_AD_METADATA || g_action == MW_ACT_AD_REGISTER) {
        char *ad = finish_ad(responseBody);
        clear_request_state();
        return ad;
    }
    free(g_req.responseData);
    g_req.responseData = mw_strdup(responseBody);
    if (g_req.responseData == NULL) {
        clear_request_state();
        return error_reply(PIANO_RET_OUT_OF_MEMORY, NULL);
    }

    PianoReturn_t ret = PianoResponse(&g_ph, &g_req);
    free(g_req.responseData);
    g_req.responseData = NULL;

    if (ret == PIANO_RET_CONTINUE_REQUEST) {
        g_pending = 0;
        return success_reply(1);
    }
    if (ret != PIANO_RET_OK) {
        /* A failed playlist fetch must not leak a partial list. */
        if (g_action == MW_ACT_PLAYLIST && g_playlist_req.retPlaylist != NULL) {
            PianoDestroyPlaylist(g_playlist_req.retPlaylist);
            g_playlist_req.retPlaylist = NULL;
        }
        clear_request_state();
        return error_reply(ret, NULL);
    }
    g_finish_body = responseBody;
    char *reply = success_reply(0);
    g_finish_body = NULL;
    clear_request_state();
    return reply;
}

/* Current station list without a round trip (JSON). */
MW_EXPORT char *mw_stations(void) {
    mw_buf b; buf_init(&b);
    buf_putc(&b, '{');
    emit_stations(&b);
    buf_putc(&b, '}');
    return buf_finish(&b);
}
