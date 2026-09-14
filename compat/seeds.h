#ifndef MELODICA_PIANO_SEEDS_INTERNAL_H
#define MELODICA_PIANO_SEEDS_INTERNAL_H

static PianoReturn_t piano_request_add_seed(PianoHandle_t *ph, PianoRequest_t *req) {
    if (!piano_mutation_ready(ph, req)) return PIANO_RET_ERR;
    PianoRequestDataAddSeed_t *data = (PianoRequestDataAddSeed_t *)req->data;
    if (data == NULL || data->station == NULL || data->station->id == NULL ||
            data->musicId == NULL) return PIANO_RET_ERR;
    req->type = PIANO_REQUEST_ADD_SEED;
    req->secure = false;
    char *json = piano_mutation_json(ph, "musicToken", data->musicId,
        "stationToken", data->station->id, piano_mutation_timestamp(ph));
    if (json == NULL) return PIANO_RET_OUT_OF_MEMORY;
    return piano_authenticated_request(ph, req, "station.addMusic", json);
}

static PianoReturn_t piano_request_delete_feedback(PianoHandle_t *ph, PianoRequest_t *req) {
    if (!piano_mutation_ready(ph, req)) return PIANO_RET_ERR;
    PianoSong_t *song = (PianoSong_t *)req->data;
    if (song == NULL || song->feedbackId == NULL) return PIANO_RET_ERR;
    req->type = PIANO_REQUEST_DELETE_FEEDBACK;
    req->secure = false;
    char *json = piano_mutation_json(ph, "feedbackId", song->feedbackId,
        NULL, NULL, piano_mutation_timestamp(ph));
    if (json == NULL) return PIANO_RET_OUT_OF_MEMORY;
    return piano_authenticated_request(ph, req, "station.deleteFeedback", json);
}

static PianoReturn_t piano_request_delete_seed(PianoHandle_t *ph, PianoRequest_t *req) {
    if (!piano_mutation_ready(ph, req)) return PIANO_RET_ERR;
    PianoRequestDataDeleteSeed_t *data = (PianoRequestDataDeleteSeed_t *)req->data;
    if (data == NULL) return PIANO_RET_ERR;
    const char *seed_id = NULL;
    if (data->song != NULL) seed_id = data->song->seedId;
    else if (data->artist != NULL) seed_id = data->artist->seedId;
    else if (data->station != NULL) seed_id = data->station->seedId;
    if (seed_id == NULL) return PIANO_RET_ERR;
    req->type = PIANO_REQUEST_DELETE_SEED;
    req->secure = false;
    char *json = piano_mutation_json(ph, "seedId", seed_id,
        NULL, NULL, piano_mutation_timestamp(ph));
    if (json == NULL) return PIANO_RET_OUT_OF_MEMORY;
    return piano_authenticated_request(ph, req, "station.deleteMusic", json);
}

static PianoReturn_t piano_response_seed_mutation(PianoHandle_t *ph, PianoRequest_t *req) {
    if (ph == NULL || req == NULL || req->responseData == NULL) {
        return PIANO_RET_INVALID_RESPONSE;
    }
    MelodicaJsonDoc doc;
    if (!melodica_json_parse(&doc, req->responseData)) return PIANO_RET_INVALID_RESPONSE;
    PianoReturn_t ret = PIANO_RET_INVALID_RESPONSE;
    const size_t root = 0u;
    const size_t stat = melodica_json_object_get(&doc, root, "stat");
    if (stat == MELODICA_JSON_NONE || stat >= doc.count ||
            doc.tokens[stat].type != MELODICA_JSON_STRING) goto cleanup;
    if (!melodica_json_string_is(&doc, stat, "ok")) {
        ret = piano_response_error(&doc, root, req);
        goto cleanup;
    }
    switch (req->type) {
        case PIANO_REQUEST_ADD_SEED:
        case PIANO_REQUEST_DELETE_FEEDBACK:
        case PIANO_REQUEST_DELETE_SEED:
            ret = PIANO_RET_OK;
            break;
        default:
            ret = PIANO_RET_ERR;
            break;
    }
cleanup:
    melodica_json_destroy(&doc);
    return ret;
}

#endif
