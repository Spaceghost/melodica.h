package main

// C layouts from include/piano.h. Protocol logic lives in this package; the C
// compatibility implementation is never linked into the native Odin library.
PianoListHead_t :: struct { next: ^PianoListHead_t }
PianoUserInfo_t :: struct { listenerId, authToken: cstring }
PianoStation_t :: struct {
	head: PianoListHead_t,
	isCreator, isQuickMix, useQuickMix: u8,
	name, id, seedId: cstring,
}
PianoSong_t :: struct {
	head: PianoListHead_t,
	artist, stationId, album, audioUrl, coverArt, musicId, title: cstring,
	seedId, feedbackId, detailUrl, trackToken: cstring,
	fileGain: f32,
	length: u32,
	rating, audioFormat: i32,
}
PianoArtist_t :: struct { head: PianoListHead_t, name, musicId, seedId: cstring, score: i32 }
PianoGenre_t :: struct { head: PianoListHead_t, name, musicId: cstring }
PianoGenreCategory_t :: struct { head: PianoListHead_t, name: cstring, genres: ^PianoGenre_t }
PianoPartner_t :: struct { incoming, outgoing: rawptr, authToken, device, user, password: cstring, id: u32 }
PianoHandle_t :: struct {
	user: PianoUserInfo_t,
	stations: ^PianoStation_t,
	genreStations: ^PianoGenreCategory_t,
	partner: PianoPartner_t,
	timeOffset: i32,
}
PianoSearchResult_t :: struct { songs: ^PianoSong_t, artists: ^PianoArtist_t }
PianoStationInfo_t :: struct {
	songSeeds: ^PianoSong_t,
	artistSeeds: ^PianoArtist_t,
	stationSeeds: ^PianoStation_t,
	feedback: ^PianoSong_t,
}
PianoSettings_t :: struct { username: cstring, explicitContentFilter: bool }
PianoStationMode_t :: struct {
	head: PianoListHead_t,
	name, description: cstring,
	isAlgorithmic, isTakeover, active: bool,
	id: i32,
}
PianoRequest_t :: struct {
	type: i32,
	secure: bool,
	data: rawptr,
	urlPath: [1024]u8,
	postData, responseData: cstring,
}
PianoRequestDataLogin_t :: struct { user, password: cstring, step: u8 }
PianoRequestDataGetPlaylist_t :: struct { station: ^PianoStation_t, quality: i32, retPlaylist: ^PianoSong_t }
PianoRequestDataRateSong_t :: struct { song: ^PianoSong_t, rating: i32 }
PianoRequestDataAddFeedback_t :: struct { stationId, trackToken: cstring, rating: i32 }
PianoRequestDataRenameStation_t :: struct { station: ^PianoStation_t, newName: cstring }
PianoRequestDataSearch_t :: struct { searchStr: cstring, searchResult: PianoSearchResult_t }
PianoRequestDataCreateStation_t :: struct { token: cstring, type: i32 }
PianoRequestDataAddSeed_t :: struct { station: ^PianoStation_t, musicId: cstring }
PianoRequestDataExplain_t :: struct { song: ^PianoSong_t, retExplain: cstring }
PianoRequestDataGetStationInfo_t :: struct { station: ^PianoStation_t, info: PianoStationInfo_t }
PianoRequestDataDeleteSeed_t :: struct { song: ^PianoSong_t, artist: ^PianoArtist_t, station: ^PianoStation_t }
PianoRequestDataChangeSettings_t :: struct { currentUsername, newUsername, currentPassword, newPassword: cstring, explicitContentFilter: i32 }
PianoRequestDataGetStationModes_t :: struct { station: ^PianoStation_t, retModes: ^PianoStationMode_t }
PianoRequestDataSetStationMode_t :: struct { station: ^PianoStation_t, id: u32 }

foreign import libc "system:c"
foreign libc {
	calloc :: proc "c" (count, size: uintptr) -> rawptr ---
	malloc :: proc "c" (size: uintptr) -> rawptr ---
	free :: proc "c" (p: rawptr) ---
	memcpy :: proc "c" (dst, src: rawptr, n: uintptr) -> rawptr ---
	strlen :: proc "c" (s: cstring) -> uintptr ---
	strcmp :: proc "c" (a, b: cstring) -> i32 ---
	strdup :: proc "c" (s: cstring) -> cstring ---
	strtol :: proc "c" (s: cstring, end: ^cstring, base: i32) -> int ---
	strtoul :: proc "c" (s: cstring, end: ^cstring, base: i32) -> uintptr ---
	time :: proc "c" (result: ^int) -> int ---
	snprintf :: proc "c" (dst: rawptr, n: uintptr, format: cstring, #c_vararg args: ..any) -> i32 ---
}
foreign import jsonc "system:json-c"
foreign jsonc {
	json_object_new_object :: proc "c" () -> rawptr ---
	json_object_new_array :: proc "c" () -> rawptr ---
	json_object_new_string :: proc "c" (s: cstring) -> rawptr ---
	json_object_new_boolean :: proc "c" (b: i32) -> rawptr ---
	json_object_new_int :: proc "c" (n: i32) -> rawptr ---
	json_object_object_add :: proc "c" (obj: rawptr, key: cstring, value: rawptr) -> i32 ---
	json_object_array_add :: proc "c" (obj, value: rawptr) -> i32 ---
	json_object_to_json_string :: proc "c" (obj: rawptr) -> cstring ---
	json_object_put :: proc "c" (obj: rawptr) -> i32 ---
	json_tokener_parse :: proc "c" (s: cstring) -> rawptr ---
	json_object_object_get_ex :: proc "c" (obj: rawptr, key: cstring, out: ^rawptr) -> i32 ---
	json_object_array_length :: proc "c" (obj: rawptr) -> uintptr ---
	json_object_array_get_idx :: proc "c" (obj: rawptr, index: uintptr) -> rawptr ---
	json_object_get_string :: proc "c" (obj: rawptr) -> cstring ---
	json_object_get_int :: proc "c" (obj: rawptr) -> i32 ---
	json_object_get_double :: proc "c" (obj: rawptr) -> f64 ---
	json_object_get_boolean :: proc "c" (obj: rawptr) -> i32 ---
	json_object_get_type :: proc "c" (obj: rawptr) -> i32 ---
}
foreign import gcrypt "system:gcrypt"
foreign gcrypt {
	gcry_check_version :: proc "c" (version: cstring) -> cstring ---
	gcry_cipher_open :: proc "c" (out: ^rawptr, algorithm, mode: i32, flags: u32) -> u32 ---
	gcry_cipher_setkey :: proc "c" (cipher, key: rawptr, length: uintptr) -> u32 ---
	gcry_cipher_close :: proc "c" (cipher: rawptr) ---
	gcry_cipher_encrypt :: proc "c" (cipher, out: rawptr, out_size: uintptr, in_buffer: rawptr, in_size: uintptr) -> u32 ---
	gcry_cipher_decrypt :: proc "c" (cipher, out: rawptr, out_size: uintptr, in_buffer: rawptr, in_size: uintptr) -> u32 ---
}

OK :: i32(1)
ERR :: i32(0)
INVALID_RESPONSE :: i32(2)
CONTINUE_REQUEST :: i32(3)
OUT_OF_MEMORY :: i32(4)
INVALID_LOGIN :: i32(5)
QUALITY_UNAVAILABLE :: i32(6)
GCRY_ERR :: i32(7)

get :: proc "contextless" (obj: rawptr, key: cstring) -> rawptr {
	v: rawptr
	json_object_object_get_ex(obj, key, &v)
	return v
}
has :: proc "contextless" (obj: rawptr, key: cstring) -> bool {
	return json_object_object_get_ex(obj, key, nil) != 0
}
jdup :: proc "contextless" (obj: rawptr, key: cstring) -> cstring {
	v := get(obj, key)
	s := json_object_get_string(v)
	if s == nil { return nil }
	return strdup(s)
}
boolean :: proc "contextless" (obj: rawptr, key: cstring, fallback := false) -> bool {
	if !has(obj, key) { return fallback }
	return json_object_get_boolean(get(obj, key)) != 0
}
add_string :: proc "contextless" (obj: rawptr, key, value: cstring) {
	json_object_object_add(obj, key, json_object_new_string(value))
}
add_bool :: proc "contextless" (obj: rawptr, key: cstring, value: bool) {
	json_object_object_add(obj, key, json_object_new_boolean(i32(value)))
}
add_int :: proc "contextless" (obj: rawptr, key: cstring, value: i32) {
	json_object_object_add(obj, key, json_object_new_int(value))
}
