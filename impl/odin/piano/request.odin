package main

// Native translation of the pinned libpiano request contract. json-c owns wire
// formatting and libgcrypt supplies Blowfish; all protocol decisions are Odin.
@(export)
PianoRequest :: proc "c" (ph: ^PianoHandle_t, req: ^PianoRequest_t, kind: i32) -> i32 {
	if ph == nil || req == nil { return ERR }
	req.type = kind
	req.secure = false
	if kind == 4 {
		d := cast(^PianoRequestDataRateSong_t)req.data
		if d == nil || d.song == nil { return ERR }
		transformed := PianoRequestDataAddFeedback_t{d.song.stationId, d.song.trackToken, d.rating}
		req.data = &transformed
		ret := PianoRequest(ph, req, 5)
		req.data = d
		req.type = kind
		return ret
	}
	j := json_object_new_object()
	if j == nil { return OUT_OF_MEMORY }
	defer json_object_put(j)
	method: cstring
	encrypted := true
	timestamp := i32(time(nil) - int(ph.timeOffset))
	switch kind {
	case 1:
		d := cast(^PianoRequestDataLogin_t)req.data
		if d == nil { return ERR }
		switch d.step {
		case 0:
			req.secure = true
			if ph.partner.user == nil || ph.partner.password == nil || ph.partner.device == nil { return ERR }
			encrypted = false
			add_string(j, "username", ph.partner.user)
			add_string(j, "password", ph.partner.password)
			add_string(j, "deviceModel", ph.partner.device)
			add_string(j, "version", "5")
			add_bool(j, "includeUrls", true)
			snprintf(&req.urlPath[0], 1024, "/services/json/?method=auth.partnerLogin")
		case 1:
			req.secure = true
			if d.user == nil || d.password == nil || ph.partner.authToken == nil { return ERR }
			add_string(j, "loginType", "user")
			add_string(j, "username", d.user)
			add_string(j, "password", d.password)
			add_string(j, "partnerAuthToken", ph.partner.authToken)
			add_int(j, "syncTime", timestamp)
			escaped := url_encode(ph.partner.authToken)
			if escaped == nil { return OUT_OF_MEMORY }
			defer free(rawptr(escaped))
			snprintf(&req.urlPath[0], 1024, "/services/json/?method=auth.userLogin&auth_token=%s&partner_id=%i", escaped, i32(ph.partner.id))
		case: // Pinned upstream sends the encrypted empty object for other steps.
		}
	case 2:
		add_bool(j, "returnAllStations", true)
		method = "user.getStationList"
	case 3:
		d := cast(^PianoRequestDataGetPlaylist_t)req.data
		if d == nil || d.station == nil || d.station.id == nil { return ERR }
		add_string(j, "stationToken", d.station.id)
		add_bool(j, "includeTrackLength", true)
		method = "station.getPlaylist"
		req.secure = true
	case 5:
		d := cast(^PianoRequestDataAddFeedback_t)req.data
		if d == nil || d.stationId == nil || d.trackToken == nil || (d.rating != 1 && d.rating != 2) { return ERR }
		add_string(j, "stationToken", d.stationId)
		add_string(j, "trackToken", d.trackToken)
		add_bool(j, "isPositive", d.rating == 1)
		method = "station.addFeedback"
	case 7:
		d := cast(^PianoRequestDataRenameStation_t)req.data
		if d == nil || d.station == nil || d.newName == nil { return ERR }
		add_string(j, "stationToken", d.station.id)
		add_string(j, "stationName", d.newName)
		method = "station.renameStation"
	case 8, 15:
		d := cast(^PianoStation_t)req.data
		if d == nil || d.id == nil { return ERR }
		add_string(j, "stationToken", d.id)
		if kind == 8 { method = "station.deleteStation" } else { method = "station.transformSharedStation" }
	case 9:
		d := cast(^PianoRequestDataSearch_t)req.data
		if d == nil || d.searchStr == nil { return ERR }
		add_string(j, "searchText", d.searchStr)
		method = "music.search"
	case 10:
		d := cast(^PianoRequestDataCreateStation_t)req.data
		if d == nil || d.token == nil { return ERR }
		if d.type == 0 { add_string(j, "musicToken", d.token) } else {
			add_string(j, "trackToken", d.token)
			if d.type == 1 { add_string(j, "musicType", "song") } else if d.type == 2 { add_string(j, "musicType", "artist") } else { return ERR }
		}
		method = "station.createStation"
	case 11:
		d := cast(^PianoRequestDataAddSeed_t)req.data
		if d == nil || d.station == nil || d.musicId == nil { return ERR }
		add_string(j, "musicToken", d.musicId)
		add_string(j, "stationToken", d.station.id)
		method = "station.addMusic"
	case 12, 18, 19, 21:
		d := cast(^PianoSong_t)req.data
		if d == nil { return ERR }
		if kind == 21 { add_string(j, "feedbackId", d.feedbackId) } else { add_string(j, "trackToken", d.trackToken) }
		switch kind {
		case 12: method = "user.sleepSong"
		case 18: method = "bookmark.addSongBookmark"
		case 19: method = "bookmark.addArtistBookmark"
		case 21: method = "station.deleteFeedback"
		}
	case 13:
		a := json_object_new_array()
		if a == nil { return OUT_OF_MEMORY }
		for s := ph.stations; s != nil; s = cast(^PianoStation_t)s.head.next {
			if s.useQuickMix != 0 && s.isQuickMix == 0 { json_object_array_add(a, json_object_new_string(s.id)) }
		}
		json_object_object_add(j, "quickMixStationIds", a)
		method = "user.setQuickMix"
	case 14: method = "station.getGenreStations"
	case 16:
		d := cast(^PianoRequestDataExplain_t)req.data
		if d == nil || d.song == nil { return ERR }
		add_string(j, "trackToken", d.song.trackToken)
		method = "track.explainTrack"
	case 20:
		d := cast(^PianoRequestDataGetStationInfo_t)req.data
		if d == nil || d.station == nil { return ERR }
		add_string(j, "stationToken", d.station.id)
		add_bool(j, "includeExtendedAttributes", true)
		add_bool(j, "includeExtraParams", true)
		method = "station.getStation"
	case 22:
		d := cast(^PianoRequestDataDeleteSeed_t)req.data
		if d == nil { return ERR }
		id: cstring
		if d.song != nil { id = d.song.seedId } else if d.artist != nil { id = d.artist.seedId } else if d.station != nil { id = d.station.seedId }
		if id == nil { return ERR }
		add_string(j, "seedId", id)
		method = "station.deleteMusic"
	case 23: method = "user.getSettings"
	case 24:
		d := cast(^PianoRequestDataChangeSettings_t)req.data
		if d == nil || d.currentUsername == nil || d.currentPassword == nil { return ERR }
		add_bool(j, "userInitiatedChange", true)
		add_string(j, "currentUsername", d.currentUsername)
		add_string(j, "currentPassword", d.currentPassword)
		if d.explicitContentFilter != 0 { add_bool(j, "isExplicitContentFilterEnabled", d.explicitContentFilter == 2) }
		if d.newUsername != nil { add_string(j, "newUsername", d.newUsername) }
		if d.newPassword != nil { add_string(j, "newPassword", d.newPassword) }
		method = "user.changeSettings"
		req.secure = true
	case 25:
		d := cast(^PianoRequestDataGetStationModes_t)req.data
		if d == nil || d.station == nil { return ERR }
		add_string(j, "stationId", d.station.id)
		method = "interactiveradio.v1.getAvailableModesSimple"
		req.secure = true
	case 26:
		d := cast(^PianoRequestDataSetStationMode_t)req.data
		if d == nil || d.station == nil { return ERR }
		add_string(j, "stationId", d.station.id)
		add_int(j, "modeId", i32(d.id))
		method = "interactiveradio.v1.setAndGetAvailableModes"
		req.secure = true
	case: return ERR
	}
	if method != nil {
		if ph.user.authToken == nil || ph.user.listenerId == nil { return ERR }
		escaped := url_encode(ph.user.authToken)
		if escaped == nil { return OUT_OF_MEMORY }
		defer free(rawptr(escaped))
		snprintf(&req.urlPath[0], 1024, "/services/json/?method=%s&auth_token=%s&partner_id=%i&user_id=%s", method, escaped, i32(ph.partner.id), ph.user.listenerId)
		add_string(j, "userAuthToken", ph.user.authToken)
		add_int(j, "syncTime", timestamp)
	}
	json := json_object_to_json_string(j)
	post: cstring
	if encrypted { post = encrypt(ph.partner.outgoing, json) } else if json != nil { post = strdup(json) }
	if post == nil { return OUT_OF_MEMORY }
	free(rawptr(req.postData))
	req.postData = post
	return OK
}
