#if defined(__GNUC__) || defined(__clang__)
#define MELODICA_INTERNAL_VIS __attribute__((visibility("hidden")))
#else
#define MELODICA_INTERNAL_VIS
#endif
#define PianoRequest MELODICA_INTERNAL_VIS melodica_piano_request_base
#define PianoResponse MELODICA_INTERNAL_VIS melodica_piano_response_base
#include "piano_base.inc"
#undef PianoRequest
#undef PianoResponse
#undef MELODICA_INTERNAL_VIS

#include "station_mutations.h"
#include "feedback.h"
#include "seeds.h"

PianoReturn_t PianoRequest(PianoHandle_t *ph, PianoRequest_t *req,
        const PianoRequestType_t type) {
    switch (type) {
        case PIANO_REQUEST_RATE_SONG:
            return piano_request_rate_song(ph, req);
        case PIANO_REQUEST_ADD_FEEDBACK:
            return piano_request_add_feedback(ph, req);
        case PIANO_REQUEST_ADD_TIRED_SONG:
            return piano_request_tired_song(ph, req);
        case PIANO_REQUEST_RENAME_STATION:
            return piano_request_rename_station(ph, req);
        case PIANO_REQUEST_DELETE_STATION:
            return piano_request_delete_station(ph, req);
        case PIANO_REQUEST_CREATE_STATION:
            return piano_request_create_station(ph, req);
        case PIANO_REQUEST_ADD_SEED:
            return piano_request_add_seed(ph, req);
        case PIANO_REQUEST_DELETE_FEEDBACK:
            return piano_request_delete_feedback(ph, req);
        case PIANO_REQUEST_DELETE_SEED:
            return piano_request_delete_seed(ph, req);
        case PIANO_REQUEST_GET_STATION_INFO:
            return piano_request_station_info(ph, req);
        default:
            return melodica_piano_request_base(ph, req, type);
    }
}

PianoReturn_t PianoResponse(PianoHandle_t *ph, PianoRequest_t *req) {
    if (req != NULL) {
        switch (req->type) {
            case PIANO_REQUEST_RATE_SONG:
            case PIANO_REQUEST_ADD_FEEDBACK:
            case PIANO_REQUEST_ADD_TIRED_SONG:
                return piano_response_feedback(ph, req);
            case PIANO_REQUEST_RENAME_STATION:
            case PIANO_REQUEST_DELETE_STATION:
            case PIANO_REQUEST_CREATE_STATION:
                return piano_response_station_mutation(ph, req);
            case PIANO_REQUEST_ADD_SEED:
            case PIANO_REQUEST_DELETE_FEEDBACK:
            case PIANO_REQUEST_DELETE_SEED:
                return piano_response_seed_mutation(ph, req);
            case PIANO_REQUEST_GET_STATION_INFO:
                return piano_response_station_info(ph, req);
            default:
                break;
        }
    }
    return melodica_piano_response_base(ph, req);
}
