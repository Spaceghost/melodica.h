#ifndef MELODICA_PIANO_PLAYLIST_INTERNAL_H
#define MELODICA_PIANO_PLAYLIST_INTERNAL_H

/* Internal implementation included by piano.c after its wire/ownership helpers.
 * This is not an installed header and does not add public ABI symbols. */
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>

static PianoReturn_t piano_request_playlist(PianoHandle_t *ph, PianoRequest_t *req) {
    PianoRequestDataGetPlaylist_t *data = (PianoRequestDataGetPlaylist_t *)req->data;
    if (ph == NULL || data == NULL || data->station == NULL ||
            data->station->id == NULL || ph->user.authToken == NULL ||
            ph->user.listenerId == NULL || ph->partner.out == NULL) return PIANO_RET_ERR;

    static const char a[] = "{ \"stationToken\": \"";
    static const char b[] = "\", \"includeTrackLength\": true, \"userAuthToken\": \"";
    static const char c[] = "\", \"syncTime\": ";
    static const char d[] = " }";
    /* The reference inserts syncTime with json_object_new_int, not int64. */
    const int32_t timestamp = (int32_t)((int64_t)time(NULL) - ph->timeOffset);
    char number[32];
    const int digits = snprintf(number, sizeof(number), "%ld", (long)timestamp);
    if (digits < 0 || (size_t)digits >= sizeof(number)) return PIANO_RET_ERR;
    size_t length = sizeof(a) + sizeof(b) + sizeof(c) + sizeof(d) - 4u + (size_t)digits;
    const size_t station_len = piano_json_escaped_size(data->station->id);
    const size_t auth_len = piano_json_escaped_size(ph->user.authToken);
    if (station_len > SIZE_MAX - length - 1u) return PIANO_RET_OUT_OF_MEMORY;
    length += station_len;
    if (auth_len > SIZE_MAX - length - 1u) return PIANO_RET_OUT_OF_MEMORY;
    length += auth_len;
    char *json = (char *)malloc(length + 1u);
    if (json == NULL) return PIANO_RET_OUT_OF_MEMORY;
    char *out = piano_copy_literal(json, a);
    out = piano_json_write_escaped(out, data->station->id);
    out = piano_copy_literal(out, b);
    out = piano_json_write_escaped(out, ph->user.authToken);
    out = piano_copy_literal(out, c);
    out = piano_copy_literal(out, number);
    out = piano_copy_literal(out, d);
    *out = '\0';
    assert((size_t)(out - json) == length);
    req->secure = true;
    return piano_authenticated_request(ph, req, "station.getPlaylist", json);
}

static PianoReturn_t piano_playlist_string(const MelodicaJsonDoc *doc,
        const size_t object, const char *key, char **out) {
    const size_t token = melodica_json_object_get(doc, object, key);
    *out = NULL;
    if (token == MELODICA_JSON_NONE) return PIANO_RET_OK;
    if (doc->tokens[token].type != MELODICA_JSON_STRING) return PIANO_RET_INVALID_RESPONSE;
    *out = melodica_json_string_dup(doc, token);
    return *out == NULL ? PIANO_RET_OUT_OF_MEMORY : PIANO_RET_OK;
}

/* Match json-c's numeric accessors on finite numbers, numeric strings, booleans,
 * null and missing values. Integer strings use integer-prefix conversion;
 * numerical JSON values are truncated and saturated before conversion to int. */
static PianoReturn_t piano_playlist_number(const MelodicaJsonDoc *doc,
        const size_t object, const char *key, const int integer, double *out) {
    const size_t token = melodica_json_object_get(doc, object, key);
    *out = 0.0;
    if (token == MELODICA_JSON_NONE) return PIANO_RET_OK;
    const MelodicaJsonToken *t = &doc->tokens[token];
    if (t->type == MELODICA_JSON_STRING) {
        char *text = melodica_json_string_dup(doc, token);
        if (text == NULL) return PIANO_RET_OUT_OF_MEMORY;
        *out = integer ? (double)strtoll(text, NULL, 10) : strtod(text, NULL);
        free(text);
    } else if (t->type == MELODICA_JSON_PRIMITIVE) {
        int boolean;
        if (melodica_json_bool(doc, token, &boolean)) {
            *out = (double)boolean;
        } else if (t->end - t->start == 4u &&
                memcmp(doc->text + t->start, "null", 4u) == 0) {
            *out = 0.0;
        } else {
            char *end;
            *out = strtod(doc->text + t->start, &end);
            if (end != doc->text + t->end) return PIANO_RET_INVALID_RESPONSE;
        }
    }
    if (integer) {
        if (isnan(*out)) return PIANO_RET_INVALID_RESPONSE;
        if (*out > INT_MAX) *out = INT_MAX;
        if (*out < INT_MIN) *out = INT_MIN;
        *out = (double)(int)*out;
    } else if (!isfinite(*out) || *out > FLT_MAX || *out < -FLT_MAX) {
        return PIANO_RET_INVALID_RESPONSE;
    }
    return PIANO_RET_OK;
}

static PianoReturn_t piano_response_playlist(PianoRequest_t *req,
        const MelodicaJsonDoc *doc, const size_t result) {
    PianoRequestDataGetPlaylist_t *data = (PianoRequestDataGetPlaylist_t *)req->data;
    if (data == NULL || data->quality < PIANO_AQ_LOW || data->quality > PIANO_AQ_HIGH) {
        return PIANO_RET_INVALID_RESPONSE;
    }
    /* json-c's object lookup simply reports no member for a missing, null or
     * non-object result. Upstream therefore returns OK and leaves retPlaylist
     * untouched for all of those shapes rather than rejecting the response. */
    if (result == MELODICA_JSON_NONE) return PIANO_RET_OK;
    if (result >= doc->count) return PIANO_RET_INVALID_RESPONSE;
    if (doc->tokens[result].type != MELODICA_JSON_OBJECT) return PIANO_RET_OK;

    const size_t items = melodica_json_object_get(doc, result, "items");
    /* Unlike an empty array, a missing items member leaves the output alone. */
    if (items == MELODICA_JSON_NONE) return PIANO_RET_OK;
    if (doc->tokens[items].type != MELODICA_JSON_ARRAY) return PIANO_RET_INVALID_RESPONSE;

    static const char *const qualities[] = {"", "lowQuality", "mediumQuality", "highQuality"};
    PianoSong_t *playlist = NULL;
    PianoSong_t *tail = NULL;
    PianoReturn_t ret = PIANO_RET_OK;
    /* Visit tokens once rather than restarting array_get for every item. */
    for (size_t item = items + 1u; item < doc->count &&
            doc->tokens[item].start < doc->tokens[items].end; ++item) {
        if (doc->tokens[item].parent != items) continue;
        if (doc->tokens[item].type != MELODICA_JSON_OBJECT) {
            ret = PIANO_RET_INVALID_RESPONSE;
            goto fail;
        }
        if (melodica_json_object_get(doc, item, "artistName") == MELODICA_JSON_NONE) continue;
        PianoSong_t *song = (PianoSong_t *)calloc(1u, sizeof(*song));
        if (song == NULL) { ret = PIANO_RET_OUT_OF_MEMORY; goto fail; }
        /* Keep partial ownership on a private list so all errors share cleanup. */
        if (tail == NULL) playlist = song;
        else tail->head.next = &song->head;
        tail = song;

        const size_t map = melodica_json_object_get(doc, item, "audioUrlMap");
        if (map != MELODICA_JSON_NONE) {
            const size_t quality = melodica_json_object_get(doc, map, qualities[data->quality]);
            char *encoding = NULL;
            ret = piano_playlist_string(doc, quality, "encoding", &encoding);
            if (ret != PIANO_RET_OK) goto fail;
            if (encoding == NULL) { ret = PIANO_RET_QUALITY_UNAVAILABLE; goto fail; }
            if (strcmp(encoding, "aacplus") == 0) song->audioFormat = PIANO_AF_AACPLUS;
            else if (strcmp(encoding, "mp3") == 0) song->audioFormat = PIANO_AF_MP3;
            free(encoding);
            ret = piano_playlist_string(doc, quality, "audioUrl", &song->audioUrl);
            if (ret != PIANO_RET_OK) goto fail;
        }

#define PLAYLIST_STRING(key, field) do { \
    ret = piano_playlist_string(doc, item, key, &song->field); \
    if (ret != PIANO_RET_OK) goto fail; \
} while (0)
        PLAYLIST_STRING("artistName", artist);
        PLAYLIST_STRING("albumName", album);
        PLAYLIST_STRING("songName", title);
        PLAYLIST_STRING("trackToken", trackToken);
        PLAYLIST_STRING("stationId", stationId);
        PLAYLIST_STRING("albumArtUrl", coverArt);
        PLAYLIST_STRING("songDetailUrl", detailUrl);
#undef PLAYLIST_STRING
        double number;
        ret = piano_playlist_number(doc, item, "trackGain", 0, &number);
        if (ret != PIANO_RET_OK) goto fail;
        song->fileGain = (float)number;
        ret = piano_playlist_number(doc, item, "trackLength", 1, &number);
        if (ret != PIANO_RET_OK) goto fail;
        song->length = (unsigned int)(int)number;
        ret = piano_playlist_number(doc, item, "songRating", 1, &number);
        if (ret != PIANO_RET_OK) goto fail;
        song->rating = number == 1.0 ? PIANO_RATE_LOVE : PIANO_RATE_NONE;
    }
    data->retPlaylist = playlist;
    return PIANO_RET_OK;
fail:
    PianoDestroyPlaylist(playlist);
    return ret;
}

#endif
