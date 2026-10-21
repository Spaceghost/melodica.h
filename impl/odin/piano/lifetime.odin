package main

@(export)
PianoListCount :: proc "c" (list: ^PianoListHead_t) -> uintptr {
	n: uintptr
	for p := list; p != nil; p = p.next { n += 1 }
	return n
}
@(export)
PianoListAppend :: proc "c" (list, entry: ^PianoListHead_t) -> rawptr {
	if list == nil { return entry }
	p := list
	for p.next != nil { p = p.next }
	p.next = entry
	return list
}
@(export)
PianoListPrepend :: proc "c" (list, entry: ^PianoListHead_t) -> rawptr {
	if entry == nil { return list }
	entry.next = list
	return entry
}
@(export)
PianoListDelete :: proc "c" (list, entry: ^PianoListHead_t) -> rawptr {
	prev: ^PianoListHead_t
	for p := list; p != nil; p = p.next {
		if p == entry {
			if prev == nil { return p.next }
			prev.next = p.next
			break
		}
		prev = p
	}
	return list
}
@(export)
PianoListGet :: proc "c" (list: ^PianoListHead_t, index: uintptr) -> rawptr {
	n := index
	for p := list; p != nil; p = p.next {
		if n == 0 { return p }
		n -= 1
	}
	return nil
}
destroy_artists :: proc "contextless" (list: ^PianoArtist_t) {
	p := list
	for p != nil {
		next := cast(^PianoArtist_t)p.head.next
		free(rawptr(p.name)); free(rawptr(p.musicId)); free(rawptr(p.seedId)); free(rawptr(p))
		p = next
	}
}
destroy_station :: proc "contextless" (p: ^PianoStation_t) {
	if p == nil { return }
	free(rawptr(p.name)); free(rawptr(p.id)); free(rawptr(p.seedId))
	p^ = {}
}
destroy_stations :: proc "contextless" (list: ^PianoStation_t) {
	p := list
	for p != nil {
		next := cast(^PianoStation_t)p.head.next
		destroy_station(p); free(rawptr(p))
		p = next
	}
}
@(export)
PianoDestroyPlaylist :: proc "c" (list: ^PianoSong_t) {
	p := list
	for p != nil {
		next := cast(^PianoSong_t)p.head.next
		free(rawptr(p.artist)); free(rawptr(p.stationId)); free(rawptr(p.album)); free(rawptr(p.audioUrl))
		free(rawptr(p.coverArt)); free(rawptr(p.musicId)); free(rawptr(p.title)); free(rawptr(p.seedId))
		free(rawptr(p.feedbackId)); free(rawptr(p.detailUrl)); free(rawptr(p.trackToken)); free(rawptr(p))
		p = next
	}
}
@(export)
PianoDestroySearchResult :: proc "c" (result: ^PianoSearchResult_t) {
	if result == nil { return }
	destroy_artists(result.artists); PianoDestroyPlaylist(result.songs)
	// The pinned API leaves caller fields untouched after releasing ownership.
}
@(export)
PianoDestroyStationInfo :: proc "c" (info: ^PianoStationInfo_t) {
	if info == nil { return }
	PianoDestroyPlaylist(info.songSeeds); PianoDestroyPlaylist(info.feedback)
	destroy_artists(info.artistSeeds); destroy_stations(info.stationSeeds)
	// Callers reset their own fields before reusing or destroying this value again.
}
@(export)
PianoDestroyStationMode :: proc "c" (list: ^PianoStationMode_t) {
	p := list
	for p != nil {
		next := cast(^PianoStationMode_t)p.head.next
		free(rawptr(p.name)); free(rawptr(p.description)); free(rawptr(p))
		p = next
	}
}
@(export)
PianoDestroy :: proc "c" (ph: ^PianoHandle_t) {
	if ph == nil { return }
	free(rawptr(ph.user.listenerId)); free(rawptr(ph.user.authToken))
	free(rawptr(ph.partner.user)); free(rawptr(ph.partner.password)); free(rawptr(ph.partner.device))
	free(rawptr(ph.partner.authToken))
	if ph.partner.incoming != nil { gcry_cipher_close(ph.partner.incoming) }
	if ph.partner.outgoing != nil { gcry_cipher_close(ph.partner.outgoing) }
	destroy_stations(ph.stations)
	p := ph.genreStations
	for p != nil {
		next := cast(^PianoGenreCategory_t)p.head.next
		g := p.genres
		for g != nil {
			gnext := cast(^PianoGenre_t)g.head.next
			free(rawptr(g.name)); free(rawptr(g.musicId)); free(rawptr(g))
			g = gnext
		}
		free(rawptr(p.name)); free(rawptr(p))
		p = next
	}
	ph^ = {}
}
@(export)
PianoInit :: proc "c" (ph: ^PianoHandle_t, user, password, device, inkey, outkey: cstring) -> i32 {
	if ph == nil { return ERR }
	ph^ = {}
	if gcry_check_version(nil) == nil { return GCRY_ERR }
	if user != nil { ph.partner.user = strdup(user) }
	if password != nil { ph.partner.password = strdup(password) }
	if device != nil { ph.partner.device = strdup(device) }
	if (user != nil && ph.partner.user == nil) || (password != nil && ph.partner.password == nil) || (device != nil && ph.partner.device == nil) {
		PianoDestroy(ph); return OUT_OF_MEMORY
	}
	if inkey == nil || outkey == nil { PianoDestroy(ph); return GCRY_ERR }
	if gcry_cipher_open(&ph.partner.incoming, 4, 1, 0) != 0 ||
	   gcry_cipher_setkey(ph.partner.incoming, rawptr(inkey), strlen(inkey)) != 0 ||
	   gcry_cipher_open(&ph.partner.outgoing, 4, 1, 0) != 0 ||
	   gcry_cipher_setkey(ph.partner.outgoing, rawptr(outkey), strlen(outkey)) != 0 {
		PianoDestroy(ph); return GCRY_ERR
	}
	return OK
}
@(export)
PianoDestroyRequest :: proc "c" (req: ^PianoRequest_t) {
	if req == nil { return }
	free(rawptr(req.postData)); req^ = {}
}
@(export)
PianoFindStationById :: proc "c" (list: ^PianoStation_t, id: cstring) -> ^PianoStation_t {
	if id == nil { return nil }
	for p := list; p != nil; p = cast(^PianoStation_t)p.head.next {
		if p.id != nil && strcmp(p.id, id) == 0 { return p }
	}
	return nil
}

encrypt :: proc "contextless" (cipher: rawptr, input: cstring) -> cstring {
	if input == nil || cipher == nil { return nil }
	n := strlen(input)
	padded := (n + 7) & ~uintptr(7)
	bytes := cast([^]u8)calloc(padded + 1, 1)
	if bytes == nil { return nil }
	defer free(rawptr(bytes))
	memcpy(bytes, rawptr(input), n)
	if gcry_cipher_encrypt(cipher, bytes, padded, nil, 0) != 0 { return nil }
	result := cast([^]u8)calloc(padded * 2 + 1, 1)
	if result == nil { return nil }
	hex := "0123456789abcdef"
	for i in 0..<padded {
		result[2*i] = hex[bytes[i] >> 4]
		result[2*i+1] = hex[bytes[i] & 15]
	}
	return cast(cstring)result
}
decrypt :: proc "contextless" (cipher: rawptr, input: cstring) -> (cstring, uintptr) {
	if input == nil || cipher == nil { return nil, 0 }
	n := strlen(input) / 2
	bytes := cast([^]u8)calloc(n+1, 1)
	if bytes == nil { return nil, 0 }
	src := cast([^]u8)input
	for i in 0..<n {
		// Preserve strtol's partial conversion, whitespace and sign behavior.
		hex := [3]u8{src[i*2], src[i*2+1], 0}
		bytes[i] = u8(strtol(cast(cstring)&hex[0], nil, 16))
	}
	if gcry_cipher_decrypt(cipher, bytes, n, nil, 0) != 0 { free(rawptr(bytes)); return nil, 0 }
	return cast(cstring)bytes, n
}
url_encode :: proc "contextless" (input: cstring) -> cstring {
	if input == nil { return nil }
	n := strlen(input)
	out := cast([^]u8)malloc(n*3+1)
	if out == nil { return nil }
	p: uintptr
	hex := "0123456789ABCDEF"
	src := cast([^]u8)input
	for i in 0..<n {
		c := src[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~' {
			out[p] = c; p += 1
		} else {
			out[p] = '%'; out[p+1] = hex[c >> 4]; out[p+2] = hex[c & 15]; p += 3
		}
	}
	out[p] = 0
	return cast(cstring)out
}
