package main

array_len :: proc "contextless" (value: rawptr) -> uintptr {
	if json_object_get_type(value) != 5 { return 0 }
	return json_object_array_length(value)
}
parse_station :: proc "contextless" (value: rawptr, station: ^PianoStation_t) {
	station.name = jdup(value, "stationName")
	station.id = jdup(value, "stationToken")
	station.isCreator = u8(!boolean(value, "isShared", true))
	station.isQuickMix = u8(boolean(value, "isQuickMix"))
}
append_text :: proc "contextless" (destination: cstring, text: cstring) {
	if destination == nil || text == nil { return }
	dst := cast([^]u8)destination
	src := cast([^]u8)text
	i := strlen(destination)
	j: uintptr
	for i < 767 && src[j] != 0 { dst[i] = src[j]; i += 1; j += 1 }
	dst[i] = 0
}

response_playlist :: proc "contextless" (req: ^PianoRequest_t, result: rawptr) -> i32 {
	d := cast(^PianoRequestDataGetPlaylist_t)req.data
	if d == nil || d.quality < 1 || d.quality > 3 { return INVALID_RESPONSE }
	if !has(result, "items") { return OK }
	items := get(result, "items")
	playlist, tail: ^PianoSong_t
	quality := [4]cstring{"", "lowQuality", "mediumQuality", "highQuality"}
	for i in 0..<array_len(items) {
		value := json_object_array_get_idx(items, i)
		if !has(value, "artistName") { continue }
		song := zeroed_PianoSong_t()
		if song == nil { PianoDestroyPlaylist(playlist); return OUT_OF_MEMORY }
		if has(value, "audioUrlMap") {
			qmap := get(get(value, "audioUrlMap"), quality[d.quality])
			if !has(qmap, "encoding") {
				free(rawptr(song)); PianoDestroyPlaylist(playlist); return QUALITY_UNAVAILABLE
			}
			encoding := json_object_get_string(get(qmap, "encoding"))
			if encoding != nil {
				if strcmp(encoding, "aacplus") == 0 { song.audioFormat = 1 }
				if strcmp(encoding, "mp3") == 0 { song.audioFormat = 2 }
			}
			song.audioUrl = jdup(qmap, "audioUrl")
		}
		song.artist = jdup(value, "artistName")
		song.album = jdup(value, "albumName")
		song.title = jdup(value, "songName")
		song.trackToken = jdup(value, "trackToken")
		song.stationId = jdup(value, "stationId")
		song.coverArt = jdup(value, "albumArtUrl")
		song.detailUrl = jdup(value, "songDetailUrl")
		song.fileGain = f32(json_object_get_double(get(value, "trackGain")))
		song.length = u32(json_object_get_int(get(value, "trackLength")))
		if json_object_get_int(get(value, "songRating")) == 1 { song.rating = 1 }
		if tail == nil { playlist = song } else { tail.head.next = &song.head }
		tail = song
	}
	d.retPlaylist = playlist
	return OK
}
response_search :: proc "contextless" (req: ^PianoRequest_t, result: rawptr) -> i32 {
	d := cast(^PianoRequestDataSearch_t)req.data
	if d == nil { return INVALID_RESPONSE }
	d.searchResult = {}
	artists := get(result, "artists")
	for i in 0..<array_len(artists) {
		value := json_object_array_get_idx(artists, i)
		artist := zeroed_PianoArtist_t()
		if artist == nil { PianoDestroySearchResult(&d.searchResult); return OUT_OF_MEMORY }
		artist.name = jdup(value, "artistName")
		artist.musicId = jdup(value, "musicToken")
		d.searchResult.artists = cast(^PianoArtist_t)PianoListAppend(cast(^PianoListHead_t)d.searchResult.artists, &artist.head)
	}
	songs := get(result, "songs")
	for i in 0..<array_len(songs) {
		value := json_object_array_get_idx(songs, i)
		song := zeroed_PianoSong_t()
		if song == nil { PianoDestroySearchResult(&d.searchResult); return OUT_OF_MEMORY }
		song.title = jdup(value, "songName")
		song.artist = jdup(value, "artistName")
		song.musicId = jdup(value, "musicToken")
		d.searchResult.songs = cast(^PianoSong_t)PianoListAppend(cast(^PianoListHead_t)d.searchResult.songs, &song.head)
	}
	return OK
}
response_station_info :: proc "contextless" (req: ^PianoRequest_t, result: rawptr) -> i32 {
	d := cast(^PianoRequestDataGetStationInfo_t)req.data
	if d == nil { return INVALID_RESPONSE }
	info: PianoStationInfo_t
	music := get(result, "music")
	songs := get(music, "songs")
	for i in 0..<array_len(songs) {
		value := json_object_array_get_idx(songs, i)
		song := zeroed_PianoSong_t()
		if song == nil { PianoDestroyStationInfo(&info); return OUT_OF_MEMORY }
		song.title = jdup(value, "songName"); song.artist = jdup(value, "artistName"); song.seedId = jdup(value, "seedId")
		info.songSeeds = cast(^PianoSong_t)PianoListAppend(cast(^PianoListHead_t)info.songSeeds, &song.head)
	}
	artists := get(music, "artists")
	for i in 0..<array_len(artists) {
		value := json_object_array_get_idx(artists, i)
		artist := zeroed_PianoArtist_t()
		if artist == nil { PianoDestroyStationInfo(&info); return OUT_OF_MEMORY }
		artist.name = jdup(value, "artistName"); artist.seedId = jdup(value, "seedId")
		info.artistSeeds = cast(^PianoArtist_t)PianoListAppend(cast(^PianoListHead_t)info.artistSeeds, &artist.head)
	}
	feedback := get(result, "feedback")
	keys := [2]cstring{"thumbsUp", "thumbsDown"}
	for key in keys {
		values := get(feedback, key)
		for i in 0..<array_len(values) {
			value := json_object_array_get_idx(values, i)
			song := zeroed_PianoSong_t()
			if song == nil { PianoDestroyStationInfo(&info); return OUT_OF_MEMORY }
			song.title = jdup(value, "songName"); song.artist = jdup(value, "artistName"); song.feedbackId = jdup(value, "feedbackId")
			song.rating = 2
			if boolean(value, "isPositive") { song.rating = 1 }
			song.length = u32(json_object_get_int(get(value, "trackLength")))
			info.feedback = cast(^PianoSong_t)PianoListAppend(cast(^PianoListHead_t)info.feedback, &song.head)
		}
	}
	if info.songSeeds != nil { d.info.songSeeds = cast(^PianoSong_t)PianoListAppend(cast(^PianoListHead_t)d.info.songSeeds, &info.songSeeds.head) }
	if info.artistSeeds != nil { d.info.artistSeeds = cast(^PianoArtist_t)PianoListAppend(cast(^PianoListHead_t)d.info.artistSeeds, &info.artistSeeds.head) }
	if info.feedback != nil { d.info.feedback = cast(^PianoSong_t)PianoListAppend(cast(^PianoListHead_t)d.info.feedback, &info.feedback.head) }
	return OK
}

@(export)
PianoResponse :: proc "c" (ph: ^PianoHandle_t, req: ^PianoRequest_t) -> i32 {
	if ph == nil || req == nil || req.responseData == nil { return INVALID_RESPONSE }
	j := json_tokener_parse(req.responseData)
	if j == nil { return INVALID_RESPONSE }
	defer json_object_put(j)
	status := json_object_get_string(get(j, "stat"))
	if status == nil { return INVALID_RESPONSE }
	if strcmp(status, "ok") != 0 {
		if !has(j, "code") { return INVALID_RESPONSE }
		ret := json_object_get_int(get(j, "code")) + 1024
		if ret == 2026 && req.type == 1 && req.data != nil && (cast(^PianoRequestDataLogin_t)req.data).step == 1 { return INVALID_LOGIN }
		return ret
	}
	result := get(j, "result")
	switch req.type {
	case 1:
		d := cast(^PianoRequestDataLogin_t)req.data
		if d == nil { return INVALID_RESPONSE }
		switch d.step {
		case 0:
			if !has(result, "syncTime") { return INVALID_RESPONSE }
			timestamp, n := decrypt(ph.partner.incoming, json_object_get_string(get(result, "syncTime")))
			ret := ERR
			if timestamp != nil && n > 4 {
				bytes := cast([^]u8)timestamp
				ph.timeOffset = i32(time(nil) - int(strtoul(cast(cstring)&bytes[4], nil, 0)))
				ret = CONTINUE_REQUEST
			}
			free(rawptr(timestamp))
			free(rawptr(ph.partner.authToken))
			ph.partner.authToken = jdup(result, "partnerAuthToken")
			if !has(result, "partnerId") { return INVALID_RESPONSE }
			ph.partner.id = u32(json_object_get_int(get(result, "partnerId")))
			d.step += 1
			return ret
		case 1:
			free(rawptr(ph.user.listenerId)); free(rawptr(ph.user.authToken))
			ph.user.listenerId = jdup(result, "userId")
			ph.user.authToken = jdup(result, "userAuthToken")
		case: return OK
		}
	case 2:
		stations := get(result, "stations")
		mix: rawptr
		for i in 0..<array_len(stations) {
			value := json_object_array_get_idx(stations, i)
			station := zeroed_PianoStation_t()
			if station == nil { return OUT_OF_MEMORY }
			parse_station(value, station)
			if station.isQuickMix != 0 { mix = get(value, "quickMixStationIds") }
			ph.stations = cast(^PianoStation_t)PianoListAppend(cast(^PianoListHead_t)ph.stations, &station.head)
		}
		for station := ph.stations; station != nil; station = cast(^PianoStation_t)station.head.next {
			for i in 0..<array_len(mix) {
				id := json_object_get_string(json_object_array_get_idx(mix, i))
				if id != nil && station.id != nil && strcmp(id, station.id) == 0 { station.useQuickMix = 1 }
			}
		}
	case 3: return response_playlist(req, result)
	case 4:
		d := cast(^PianoRequestDataRateSong_t)req.data
		if d == nil || d.song == nil { return INVALID_RESPONSE }
		d.song.rating = d.rating
	case 5: return ERR // Pinned upstream asserts for a direct low-level success.
	case 7:
		d := cast(^PianoRequestDataRenameStation_t)req.data
		if d == nil || d.station == nil || d.newName == nil { return INVALID_RESPONSE }
		name := strdup(d.newName)
		if name == nil { return OUT_OF_MEMORY }
		free(rawptr(d.station.name)); d.station.name = name
	case 8:
		station := cast(^PianoStation_t)req.data
		if station == nil { return INVALID_RESPONSE }
		ph.stations = cast(^PianoStation_t)PianoListDelete(cast(^PianoListHead_t)ph.stations, &station.head)
		destroy_station(station); free(rawptr(station))
	case 9: return response_search(req, result)
	case 10:
		station := zeroed_PianoStation_t()
		if station == nil { return OUT_OF_MEMORY }
		parse_station(result, station)
		existing := PianoFindStationById(ph.stations, station.id)
		if existing != nil {
			ph.stations = cast(^PianoStation_t)PianoListDelete(cast(^PianoListHead_t)ph.stations, &existing.head)
			destroy_station(existing); free(rawptr(existing))
		}
		ph.stations = cast(^PianoStation_t)PianoListAppend(cast(^PianoListHead_t)ph.stations, &station.head)
	case 12:
		song := cast(^PianoSong_t)req.data
		if song == nil { return INVALID_RESPONSE }
		song.rating = 3
	case 11, 13, 18, 19, 21, 22, 24: // Successful bodies are intentionally unused.
	case 14:
		categories := get(result, "categories")
		for i in 0..<array_len(categories) {
			value := json_object_array_get_idx(categories, i)
			category := zeroed_PianoGenreCategory_t()
			if category == nil { return OUT_OF_MEMORY }
			category.name = jdup(value, "categoryName")
			ph.genreStations = cast(^PianoGenreCategory_t)PianoListAppend(cast(^PianoListHead_t)ph.genreStations, &category.head)
			stations := get(value, "stations")
			for k in 0..<array_len(stations) {
				station := json_object_array_get_idx(stations, k)
				genre := zeroed_PianoGenre_t()
				if genre == nil { return OUT_OF_MEMORY }
				genre.name = jdup(station, "stationName"); genre.musicId = jdup(station, "stationToken")
				category.genres = cast(^PianoGenre_t)PianoListAppend(cast(^PianoListHead_t)category.genres, &genre.head)
			}
		}
	case 15:
		station := cast(^PianoStation_t)req.data
		if station == nil { return INVALID_RESPONSE }
		station.isCreator = 1
	case 16:
		d := cast(^PianoRequestDataExplain_t)req.data
		if d == nil { return INVALID_RESPONSE }
		explanations := get(result, "explanations")
		n := array_len(explanations)
		if n > 0 {
			d.retExplain = cast(cstring)calloc(768, 1)
			if d.retExplain == nil { return OUT_OF_MEMORY }
			append_text(d.retExplain, "We're playing this track because it features ")
			for i in 0..<n {
				e := json_object_array_get_idx(explanations, i)
				if !has(e, "focusTraitName") { continue }
				append_text(d.retExplain, json_object_get_string(get(e, "focusTraitName")))
				if n == 1 || i < n-2 { append_text(d.retExplain, ", ") } else if i == n-2 { append_text(d.retExplain, " and ") } else { append_text(d.retExplain, ".") }
			}
		}
	case 20: return response_station_info(req, result)
	case 23:
		d := cast(^PianoSettings_t)req.data
		if d == nil { return INVALID_RESPONSE }
		d.username = jdup(result, "username")
		d.explicitContentFilter = boolean(result, "isExplicitContentFilterEnabled")
	case 25:
		d := cast(^PianoRequestDataGetStationModes_t)req.data
		if d == nil { return INVALID_RESPONSE }
		active := i32(-1)
		if has(result, "currentModeId") { active = json_object_get_int(get(result, "currentModeId")) }
		modes := get(result, "availableModes")
		for i in 0..<array_len(modes) {
			value := json_object_array_get_idx(modes, i)
			mode := zeroed_PianoStationMode_t()
			if mode == nil { return OUT_OF_MEMORY }
			if has(value, "modeId") {
				mode.id = json_object_get_int(get(value, "modeId"))
				mode.name = jdup(value, "modeName"); mode.description = jdup(value, "modeDescription")
				mode.isAlgorithmic = boolean(value, "isAlgorithmicMode")
				mode.isTakeover = boolean(value, "isTakeoverMode")
				mode.active = mode.id == active
			}
			d.retModes = cast(^PianoStationMode_t)PianoListAppend(cast(^PianoListHead_t)d.retModes, &mode.head)
		}
	case 26:
		d := cast(^PianoRequestDataSetStationMode_t)req.data
		if d == nil { return INVALID_RESPONSE }
		active := i32(-1)
		if has(result, "currentModeId") { active = json_object_get_int(get(result, "currentModeId")) }
		if active != i32(d.id) { return ERR }
	case: return ERR
	}
	return OK
}

@(export)
PianoErrorToStr :: proc "c" (code: i32) -> cstring {
	switch code {
	case 0: return "Unknown."
	case 1: return "Everything is fine :)"
	case 2: return "Invalid response."
	case 3: return "Fix your program."
	case 4: return "Out of memory."
	case 5: return "Wrong email address or password."
	case 6: return "Selected audio quality is not available."
	case 7: return "libgcrypt initialization failed."
	case 1024: return "Internal error."
	case 1025: return "Maintenance mode."
	case 1036: return "Pandora is not available in your country. Set up a control proxy (see manpage)."
	case 2024: return "Read only mode. Try again later."
	case 2025: return "Invalid auth token."
	case 2026: return "Invalid partner login."
	case 2027: return "Listener not authorized."
	case 2029: return "Max number of stations reached."
	case 2030: return "Station does not exist."
	case 2032: return "Call not allowed."
	case 2034: return "Invalid partner credentials."
	case 2063: return "Access denied. Try again later."
	case: return "No error message available."
	}
}

zeroed_PianoSong_t :: proc "contextless" () -> ^PianoSong_t { return cast(^PianoSong_t)calloc(1, size_of(PianoSong_t)) }

zeroed_PianoArtist_t :: proc "contextless" () -> ^PianoArtist_t { return cast(^PianoArtist_t)calloc(1, size_of(PianoArtist_t)) }

zeroed_PianoStation_t :: proc "contextless" () -> ^PianoStation_t { return cast(^PianoStation_t)calloc(1, size_of(PianoStation_t)) }

zeroed_PianoGenreCategory_t :: proc "contextless" () -> ^PianoGenreCategory_t { return cast(^PianoGenreCategory_t)calloc(1, size_of(PianoGenreCategory_t)) }

zeroed_PianoGenre_t :: proc "contextless" () -> ^PianoGenre_t { return cast(^PianoGenre_t)calloc(1, size_of(PianoGenre_t)) }

zeroed_PianoStationMode_t :: proc "contextless" () -> ^PianoStationMode_t { return cast(^PianoStationMode_t)calloc(1, size_of(PianoStationMode_t)) }
