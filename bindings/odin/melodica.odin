package melodica

import "core:c"

// Thin Odin ABI for dist/melodica.h. The implementation remains the generated
// C99 release; this package deliberately contains no duplicate protocol logic.

OK            :: 0
NOT_FOUND     :: 1
INVALID_JSON  :: 2
NO_SPACE      :: 3
BAD_ARGUMENT  :: 4
OVERFLOW      :: 5

TRACK_SONG_TITLE     :: u32(1)
TRACK_ARTIST_NAME    :: u32(2)
TRACK_ALBUM_TITLE    :: u32(4)
TRACK_TOKEN          :: u32(8)
TRACK_STATION_ID     :: u32(16)
TRACK_AUDIO_URL      :: u32(32)
TRACK_AUDIO_ENCODING :: u32(64)
TRACK_LENGTH         :: u32(128)
TRACK_ALLOW_SKIP     :: u32(256)
TRACK_ALL            :: u32(511)

STATION_ID              :: u32(1)
STATION_PANDORA_ID      :: u32(2)
STATION_ART_ID          :: u32(4)
STATION_NAME            :: u32(8)
STATION_CREATOR_WEBNAME :: u32(16)
STATION_ALL             :: u32(31)

LOGIN_AUTH_TOKEN :: u32(1)
LOGIN_USERNAME   :: u32(2)
LOGIN_WEB_NAME   :: u32(4)
LOGIN_USER_ID    :: u32(8)
LOGIN_ALL        :: u32(15)

ENDPOINT_LOGIN            :: "/api/v1/auth/login"
ENDPOINT_STATIONS         :: "/api/v1/station/getStations"
ENDPOINT_PLAYLIST         :: "/api/v1/playlist/getFragment"
ENDPOINT_FEEDBACK         :: "/api/v1/station/addFeedback"
ENDPOINT_TIRED            :: "/api/v1/listener/addTiredSong"
ENDPOINT_NARRATIVE        :: "/api/v1/playlist/narrative"
ENDPOINT_TRACK_STARTED    :: "/api/v1/listener/trackStarted"
ENDPOINT_PLAYBACK_PAUSED  :: "/api/v1/playback/playbackPaused"
ENDPOINT_STATION_DETAILS  :: "/api/v1/station/getStationDetails"
ENDPOINT_STATION_FEEDBACK :: "/api/v1/station/getStationFeedback"

Slice :: struct {
    offset: c.size_t,
    length: c.size_t,
}

Track_View :: struct {
    present:        u32,
    song_title:     Slice,
    artist_name:    Slice,
    album_title:    Slice,
    track_token:    Slice,
    station_id:     Slice,
    audio_url:      Slice,
    audio_encoding: Slice,
    track_length:   u64,
    allow_skip:     c.int,
}

Station_View :: struct {
    present:         u32,
    station_id:      Slice,
    pandora_id:      Slice,
    art_id:          Slice,
    name:            Slice,
    creator_webname: Slice,
}

Login_View :: struct {
    present:    u32,
    auth_token: Slice,
    username:   Slice,
    web_name:   Slice,
    user_id:    Slice,
}

foreign import lib "../../build/languages/libmelodica.a"

foreign lib {
    melodica_version :: proc() -> c.uint ---

    melodica_find_string :: proc(
        json: cstring, json_len: c.size_t,
        key: cstring, key_len: c.size_t,
        value_offset, value_len: ^c.size_t,
    ) -> c.int ---

    melodica_find_bool :: proc(
        json: cstring, json_len: c.size_t,
        key: cstring, key_len: c.size_t,
        value: ^c.int,
    ) -> c.int ---

    melodica_find_u64 :: proc(
        json: cstring, json_len: c.size_t,
        key: cstring, key_len: c.size_t,
        value: ^u64,
    ) -> c.int ---

    melodica_parse_track :: proc(json: cstring, json_len: c.size_t, track: ^Track_View) -> c.int ---
    melodica_parse_station :: proc(json: cstring, json_len: c.size_t, station: ^Station_View) -> c.int ---
    melodica_parse_login :: proc(json: cstring, json_len: c.size_t, login: ^Login_View) -> c.int ---

    melodica_track_next :: proc(json: cstring, json_len: c.size_t, cursor: ^c.size_t, track: ^Track_View) -> c.int ---
    melodica_station_next :: proc(json: cstring, json_len: c.size_t, cursor: ^c.size_t, station: ^Station_View) -> c.int ---

    melodica_json_escape :: proc(
        input: cstring, input_len: c.size_t,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_login_body :: proc(
        username: cstring, username_len: c.size_t,
        password: cstring, password_len: c.size_t,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_stations_body :: proc(
        page_size, start_index: c.uint,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_playlist_body :: proc(
        station_id: cstring, station_id_len: c.size_t,
        station_start: c.int,
        audio_format: cstring, audio_format_len: c.size_t,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_feedback_body :: proc(
        track_token: cstring, track_token_len: c.size_t,
        positive: c.int,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_tired_body :: proc(
        track_token: cstring, track_token_len: c.size_t,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_narrative_body :: proc(
        station_id: cstring, station_id_len: c.size_t,
        music_id: cstring, music_id_len: c.size_t,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_track_started_body :: proc(
        track_token: cstring, track_token_len: c.size_t,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_playback_paused_body :: proc(
        sync: c.int,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_station_details_body :: proc(
        station_id: cstring, station_id_len: c.size_t,
        is_current_station: c.int,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---

    melodica_station_feedback_body :: proc(
        station_id: cstring, station_id_len: c.size_t,
        page_size, start_index: c.uint,
        positive: c.int,
        output: rawptr, output_cap: c.size_t, output_len: ^c.size_t,
    ) -> c.int ---
}

parse_login :: proc(json: string, login: ^Login_View) -> c.int {
    return melodica_parse_login(cstring(raw_data(json)), c.size_t(len(json)), login)
}

slice_string :: proc(json: string, s: Slice) -> string {
    start := int(s.offset)
    return json[start:start + int(s.length)]
}
