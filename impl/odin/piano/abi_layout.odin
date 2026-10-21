package main

// Native layout introspection for the C ABI verifier. IDs and property order
// are recorded in tests/reference/native_abi_layout.json.
@(export)
melodica_piano_abi_layout :: proc "c" (type_id, property: u32) -> uintptr {
	switch type_id {
	case 0:
		switch property {
		case 0: return uintptr(size_of(PianoListHead_t))
		case 1: return uintptr(align_of(PianoListHead_t))
		case 2: return uintptr(offset_of(PianoListHead_t, next))
		case 3: return uintptr(size_of((PianoListHead_t{}).next))
		}
	case 1:
		switch property {
		case 0: return uintptr(size_of(PianoUserInfo_t))
		case 1: return uintptr(align_of(PianoUserInfo_t))
		case 2: return uintptr(offset_of(PianoUserInfo_t, listenerId))
		case 3: return uintptr(size_of((PianoUserInfo_t{}).listenerId))
		case 4: return uintptr(offset_of(PianoUserInfo_t, authToken))
		case 5: return uintptr(size_of((PianoUserInfo_t{}).authToken))
		}
	case 2:
		switch property {
		case 0: return uintptr(size_of(PianoStation_t))
		case 1: return uintptr(align_of(PianoStation_t))
		case 2: return uintptr(offset_of(PianoStation_t, head))
		case 3: return uintptr(size_of((PianoStation_t{}).head))
		case 4: return uintptr(offset_of(PianoStation_t, isCreator))
		case 5: return uintptr(size_of((PianoStation_t{}).isCreator))
		case 6: return uintptr(offset_of(PianoStation_t, isQuickMix))
		case 7: return uintptr(size_of((PianoStation_t{}).isQuickMix))
		case 8: return uintptr(offset_of(PianoStation_t, useQuickMix))
		case 9: return uintptr(size_of((PianoStation_t{}).useQuickMix))
		case 10: return uintptr(offset_of(PianoStation_t, name))
		case 11: return uintptr(size_of((PianoStation_t{}).name))
		case 12: return uintptr(offset_of(PianoStation_t, id))
		case 13: return uintptr(size_of((PianoStation_t{}).id))
		case 14: return uintptr(offset_of(PianoStation_t, seedId))
		case 15: return uintptr(size_of((PianoStation_t{}).seedId))
		}
	case 3:
		switch property {
		case 0: return uintptr(size_of(PianoSong_t))
		case 1: return uintptr(align_of(PianoSong_t))
		case 2: return uintptr(offset_of(PianoSong_t, head))
		case 3: return uintptr(size_of((PianoSong_t{}).head))
		case 4: return uintptr(offset_of(PianoSong_t, artist))
		case 5: return uintptr(size_of((PianoSong_t{}).artist))
		case 6: return uintptr(offset_of(PianoSong_t, stationId))
		case 7: return uintptr(size_of((PianoSong_t{}).stationId))
		case 8: return uintptr(offset_of(PianoSong_t, album))
		case 9: return uintptr(size_of((PianoSong_t{}).album))
		case 10: return uintptr(offset_of(PianoSong_t, audioUrl))
		case 11: return uintptr(size_of((PianoSong_t{}).audioUrl))
		case 12: return uintptr(offset_of(PianoSong_t, coverArt))
		case 13: return uintptr(size_of((PianoSong_t{}).coverArt))
		case 14: return uintptr(offset_of(PianoSong_t, musicId))
		case 15: return uintptr(size_of((PianoSong_t{}).musicId))
		case 16: return uintptr(offset_of(PianoSong_t, title))
		case 17: return uintptr(size_of((PianoSong_t{}).title))
		case 18: return uintptr(offset_of(PianoSong_t, seedId))
		case 19: return uintptr(size_of((PianoSong_t{}).seedId))
		case 20: return uintptr(offset_of(PianoSong_t, feedbackId))
		case 21: return uintptr(size_of((PianoSong_t{}).feedbackId))
		case 22: return uintptr(offset_of(PianoSong_t, detailUrl))
		case 23: return uintptr(size_of((PianoSong_t{}).detailUrl))
		case 24: return uintptr(offset_of(PianoSong_t, trackToken))
		case 25: return uintptr(size_of((PianoSong_t{}).trackToken))
		case 26: return uintptr(offset_of(PianoSong_t, fileGain))
		case 27: return uintptr(size_of((PianoSong_t{}).fileGain))
		case 28: return uintptr(offset_of(PianoSong_t, length))
		case 29: return uintptr(size_of((PianoSong_t{}).length))
		case 30: return uintptr(offset_of(PianoSong_t, rating))
		case 31: return uintptr(size_of((PianoSong_t{}).rating))
		case 32: return uintptr(offset_of(PianoSong_t, audioFormat))
		case 33: return uintptr(size_of((PianoSong_t{}).audioFormat))
		}
	case 4:
		switch property {
		case 0: return uintptr(size_of(PianoArtist_t))
		case 1: return uintptr(align_of(PianoArtist_t))
		case 2: return uintptr(offset_of(PianoArtist_t, head))
		case 3: return uintptr(size_of((PianoArtist_t{}).head))
		case 4: return uintptr(offset_of(PianoArtist_t, name))
		case 5: return uintptr(size_of((PianoArtist_t{}).name))
		case 6: return uintptr(offset_of(PianoArtist_t, musicId))
		case 7: return uintptr(size_of((PianoArtist_t{}).musicId))
		case 8: return uintptr(offset_of(PianoArtist_t, seedId))
		case 9: return uintptr(size_of((PianoArtist_t{}).seedId))
		case 10: return uintptr(offset_of(PianoArtist_t, score))
		case 11: return uintptr(size_of((PianoArtist_t{}).score))
		}
	case 5:
		switch property {
		case 0: return uintptr(size_of(PianoGenre_t))
		case 1: return uintptr(align_of(PianoGenre_t))
		case 2: return uintptr(offset_of(PianoGenre_t, head))
		case 3: return uintptr(size_of((PianoGenre_t{}).head))
		case 4: return uintptr(offset_of(PianoGenre_t, name))
		case 5: return uintptr(size_of((PianoGenre_t{}).name))
		case 6: return uintptr(offset_of(PianoGenre_t, musicId))
		case 7: return uintptr(size_of((PianoGenre_t{}).musicId))
		}
	case 6:
		switch property {
		case 0: return uintptr(size_of(PianoGenreCategory_t))
		case 1: return uintptr(align_of(PianoGenreCategory_t))
		case 2: return uintptr(offset_of(PianoGenreCategory_t, head))
		case 3: return uintptr(size_of((PianoGenreCategory_t{}).head))
		case 4: return uintptr(offset_of(PianoGenreCategory_t, name))
		case 5: return uintptr(size_of((PianoGenreCategory_t{}).name))
		case 6: return uintptr(offset_of(PianoGenreCategory_t, genres))
		case 7: return uintptr(size_of((PianoGenreCategory_t{}).genres))
		}
	case 7:
		switch property {
		case 0: return uintptr(size_of(PianoPartner_t))
		case 1: return uintptr(align_of(PianoPartner_t))
		case 2: return uintptr(offset_of(PianoPartner_t, incoming))
		case 3: return uintptr(size_of((PianoPartner_t{}).incoming))
		case 4: return uintptr(offset_of(PianoPartner_t, outgoing))
		case 5: return uintptr(size_of((PianoPartner_t{}).outgoing))
		case 6: return uintptr(offset_of(PianoPartner_t, authToken))
		case 7: return uintptr(size_of((PianoPartner_t{}).authToken))
		case 8: return uintptr(offset_of(PianoPartner_t, device))
		case 9: return uintptr(size_of((PianoPartner_t{}).device))
		case 10: return uintptr(offset_of(PianoPartner_t, user))
		case 11: return uintptr(size_of((PianoPartner_t{}).user))
		case 12: return uintptr(offset_of(PianoPartner_t, password))
		case 13: return uintptr(size_of((PianoPartner_t{}).password))
		case 14: return uintptr(offset_of(PianoPartner_t, id))
		case 15: return uintptr(size_of((PianoPartner_t{}).id))
		}
	case 8:
		switch property {
		case 0: return uintptr(size_of(PianoHandle_t))
		case 1: return uintptr(align_of(PianoHandle_t))
		case 2: return uintptr(offset_of(PianoHandle_t, user))
		case 3: return uintptr(size_of((PianoHandle_t{}).user))
		case 4: return uintptr(offset_of(PianoHandle_t, stations))
		case 5: return uintptr(size_of((PianoHandle_t{}).stations))
		case 6: return uintptr(offset_of(PianoHandle_t, genreStations))
		case 7: return uintptr(size_of((PianoHandle_t{}).genreStations))
		case 8: return uintptr(offset_of(PianoHandle_t, partner))
		case 9: return uintptr(size_of((PianoHandle_t{}).partner))
		case 10: return uintptr(offset_of(PianoHandle_t, timeOffset))
		case 11: return uintptr(size_of((PianoHandle_t{}).timeOffset))
		}
	case 9:
		switch property {
		case 0: return uintptr(size_of(PianoSearchResult_t))
		case 1: return uintptr(align_of(PianoSearchResult_t))
		case 2: return uintptr(offset_of(PianoSearchResult_t, songs))
		case 3: return uintptr(size_of((PianoSearchResult_t{}).songs))
		case 4: return uintptr(offset_of(PianoSearchResult_t, artists))
		case 5: return uintptr(size_of((PianoSearchResult_t{}).artists))
		}
	case 10:
		switch property {
		case 0: return uintptr(size_of(PianoStationInfo_t))
		case 1: return uintptr(align_of(PianoStationInfo_t))
		case 2: return uintptr(offset_of(PianoStationInfo_t, songSeeds))
		case 3: return uintptr(size_of((PianoStationInfo_t{}).songSeeds))
		case 4: return uintptr(offset_of(PianoStationInfo_t, artistSeeds))
		case 5: return uintptr(size_of((PianoStationInfo_t{}).artistSeeds))
		case 6: return uintptr(offset_of(PianoStationInfo_t, stationSeeds))
		case 7: return uintptr(size_of((PianoStationInfo_t{}).stationSeeds))
		case 8: return uintptr(offset_of(PianoStationInfo_t, feedback))
		case 9: return uintptr(size_of((PianoStationInfo_t{}).feedback))
		}
	case 11:
		switch property {
		case 0: return uintptr(size_of(PianoSettings_t))
		case 1: return uintptr(align_of(PianoSettings_t))
		case 2: return uintptr(offset_of(PianoSettings_t, username))
		case 3: return uintptr(size_of((PianoSettings_t{}).username))
		case 4: return uintptr(offset_of(PianoSettings_t, explicitContentFilter))
		case 5: return uintptr(size_of((PianoSettings_t{}).explicitContentFilter))
		}
	case 12:
		switch property {
		case 0: return uintptr(size_of(PianoStationMode_t))
		case 1: return uintptr(align_of(PianoStationMode_t))
		case 2: return uintptr(offset_of(PianoStationMode_t, head))
		case 3: return uintptr(size_of((PianoStationMode_t{}).head))
		case 4: return uintptr(offset_of(PianoStationMode_t, name))
		case 5: return uintptr(size_of((PianoStationMode_t{}).name))
		case 6: return uintptr(offset_of(PianoStationMode_t, description))
		case 7: return uintptr(size_of((PianoStationMode_t{}).description))
		case 8: return uintptr(offset_of(PianoStationMode_t, isAlgorithmic))
		case 9: return uintptr(size_of((PianoStationMode_t{}).isAlgorithmic))
		case 10: return uintptr(offset_of(PianoStationMode_t, isTakeover))
		case 11: return uintptr(size_of((PianoStationMode_t{}).isTakeover))
		case 12: return uintptr(offset_of(PianoStationMode_t, active))
		case 13: return uintptr(size_of((PianoStationMode_t{}).active))
		case 14: return uintptr(offset_of(PianoStationMode_t, id))
		case 15: return uintptr(size_of((PianoStationMode_t{}).id))
		}
	case 13:
		switch property {
		case 0: return uintptr(size_of(PianoRequest_t))
		case 1: return uintptr(align_of(PianoRequest_t))
		case 2: return uintptr(offset_of(PianoRequest_t, type))
		case 3: return uintptr(size_of((PianoRequest_t{}).type))
		case 4: return uintptr(offset_of(PianoRequest_t, secure))
		case 5: return uintptr(size_of((PianoRequest_t{}).secure))
		case 6: return uintptr(offset_of(PianoRequest_t, data))
		case 7: return uintptr(size_of((PianoRequest_t{}).data))
		case 8: return uintptr(offset_of(PianoRequest_t, urlPath))
		case 9: return uintptr(size_of((PianoRequest_t{}).urlPath))
		case 10: return uintptr(offset_of(PianoRequest_t, postData))
		case 11: return uintptr(size_of((PianoRequest_t{}).postData))
		case 12: return uintptr(offset_of(PianoRequest_t, responseData))
		case 13: return uintptr(size_of((PianoRequest_t{}).responseData))
		}
	case 14:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataLogin_t))
		case 1: return uintptr(align_of(PianoRequestDataLogin_t))
		case 2: return uintptr(offset_of(PianoRequestDataLogin_t, user))
		case 3: return uintptr(size_of((PianoRequestDataLogin_t{}).user))
		case 4: return uintptr(offset_of(PianoRequestDataLogin_t, password))
		case 5: return uintptr(size_of((PianoRequestDataLogin_t{}).password))
		case 6: return uintptr(offset_of(PianoRequestDataLogin_t, step))
		case 7: return uintptr(size_of((PianoRequestDataLogin_t{}).step))
		}
	case 15:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataGetPlaylist_t))
		case 1: return uintptr(align_of(PianoRequestDataGetPlaylist_t))
		case 2: return uintptr(offset_of(PianoRequestDataGetPlaylist_t, station))
		case 3: return uintptr(size_of((PianoRequestDataGetPlaylist_t{}).station))
		case 4: return uintptr(offset_of(PianoRequestDataGetPlaylist_t, quality))
		case 5: return uintptr(size_of((PianoRequestDataGetPlaylist_t{}).quality))
		case 6: return uintptr(offset_of(PianoRequestDataGetPlaylist_t, retPlaylist))
		case 7: return uintptr(size_of((PianoRequestDataGetPlaylist_t{}).retPlaylist))
		}
	case 16:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataRateSong_t))
		case 1: return uintptr(align_of(PianoRequestDataRateSong_t))
		case 2: return uintptr(offset_of(PianoRequestDataRateSong_t, song))
		case 3: return uintptr(size_of((PianoRequestDataRateSong_t{}).song))
		case 4: return uintptr(offset_of(PianoRequestDataRateSong_t, rating))
		case 5: return uintptr(size_of((PianoRequestDataRateSong_t{}).rating))
		}
	case 17:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataAddFeedback_t))
		case 1: return uintptr(align_of(PianoRequestDataAddFeedback_t))
		case 2: return uintptr(offset_of(PianoRequestDataAddFeedback_t, stationId))
		case 3: return uintptr(size_of((PianoRequestDataAddFeedback_t{}).stationId))
		case 4: return uintptr(offset_of(PianoRequestDataAddFeedback_t, trackToken))
		case 5: return uintptr(size_of((PianoRequestDataAddFeedback_t{}).trackToken))
		case 6: return uintptr(offset_of(PianoRequestDataAddFeedback_t, rating))
		case 7: return uintptr(size_of((PianoRequestDataAddFeedback_t{}).rating))
		}
	case 18:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataRenameStation_t))
		case 1: return uintptr(align_of(PianoRequestDataRenameStation_t))
		case 2: return uintptr(offset_of(PianoRequestDataRenameStation_t, station))
		case 3: return uintptr(size_of((PianoRequestDataRenameStation_t{}).station))
		case 4: return uintptr(offset_of(PianoRequestDataRenameStation_t, newName))
		case 5: return uintptr(size_of((PianoRequestDataRenameStation_t{}).newName))
		}
	case 19:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataSearch_t))
		case 1: return uintptr(align_of(PianoRequestDataSearch_t))
		case 2: return uintptr(offset_of(PianoRequestDataSearch_t, searchStr))
		case 3: return uintptr(size_of((PianoRequestDataSearch_t{}).searchStr))
		case 4: return uintptr(offset_of(PianoRequestDataSearch_t, searchResult))
		case 5: return uintptr(size_of((PianoRequestDataSearch_t{}).searchResult))
		}
	case 20:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataCreateStation_t))
		case 1: return uintptr(align_of(PianoRequestDataCreateStation_t))
		case 2: return uintptr(offset_of(PianoRequestDataCreateStation_t, token))
		case 3: return uintptr(size_of((PianoRequestDataCreateStation_t{}).token))
		case 4: return uintptr(offset_of(PianoRequestDataCreateStation_t, type))
		case 5: return uintptr(size_of((PianoRequestDataCreateStation_t{}).type))
		}
	case 21:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataAddSeed_t))
		case 1: return uintptr(align_of(PianoRequestDataAddSeed_t))
		case 2: return uintptr(offset_of(PianoRequestDataAddSeed_t, station))
		case 3: return uintptr(size_of((PianoRequestDataAddSeed_t{}).station))
		case 4: return uintptr(offset_of(PianoRequestDataAddSeed_t, musicId))
		case 5: return uintptr(size_of((PianoRequestDataAddSeed_t{}).musicId))
		}
	case 22:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataExplain_t))
		case 1: return uintptr(align_of(PianoRequestDataExplain_t))
		case 2: return uintptr(offset_of(PianoRequestDataExplain_t, song))
		case 3: return uintptr(size_of((PianoRequestDataExplain_t{}).song))
		case 4: return uintptr(offset_of(PianoRequestDataExplain_t, retExplain))
		case 5: return uintptr(size_of((PianoRequestDataExplain_t{}).retExplain))
		}
	case 23:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataGetStationInfo_t))
		case 1: return uintptr(align_of(PianoRequestDataGetStationInfo_t))
		case 2: return uintptr(offset_of(PianoRequestDataGetStationInfo_t, station))
		case 3: return uintptr(size_of((PianoRequestDataGetStationInfo_t{}).station))
		case 4: return uintptr(offset_of(PianoRequestDataGetStationInfo_t, info))
		case 5: return uintptr(size_of((PianoRequestDataGetStationInfo_t{}).info))
		}
	case 24:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataDeleteSeed_t))
		case 1: return uintptr(align_of(PianoRequestDataDeleteSeed_t))
		case 2: return uintptr(offset_of(PianoRequestDataDeleteSeed_t, song))
		case 3: return uintptr(size_of((PianoRequestDataDeleteSeed_t{}).song))
		case 4: return uintptr(offset_of(PianoRequestDataDeleteSeed_t, artist))
		case 5: return uintptr(size_of((PianoRequestDataDeleteSeed_t{}).artist))
		case 6: return uintptr(offset_of(PianoRequestDataDeleteSeed_t, station))
		case 7: return uintptr(size_of((PianoRequestDataDeleteSeed_t{}).station))
		}
	case 25:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataChangeSettings_t))
		case 1: return uintptr(align_of(PianoRequestDataChangeSettings_t))
		case 2: return uintptr(offset_of(PianoRequestDataChangeSettings_t, currentUsername))
		case 3: return uintptr(size_of((PianoRequestDataChangeSettings_t{}).currentUsername))
		case 4: return uintptr(offset_of(PianoRequestDataChangeSettings_t, newUsername))
		case 5: return uintptr(size_of((PianoRequestDataChangeSettings_t{}).newUsername))
		case 6: return uintptr(offset_of(PianoRequestDataChangeSettings_t, currentPassword))
		case 7: return uintptr(size_of((PianoRequestDataChangeSettings_t{}).currentPassword))
		case 8: return uintptr(offset_of(PianoRequestDataChangeSettings_t, newPassword))
		case 9: return uintptr(size_of((PianoRequestDataChangeSettings_t{}).newPassword))
		case 10: return uintptr(offset_of(PianoRequestDataChangeSettings_t, explicitContentFilter))
		case 11: return uintptr(size_of((PianoRequestDataChangeSettings_t{}).explicitContentFilter))
		}
	case 26:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataGetStationModes_t))
		case 1: return uintptr(align_of(PianoRequestDataGetStationModes_t))
		case 2: return uintptr(offset_of(PianoRequestDataGetStationModes_t, station))
		case 3: return uintptr(size_of((PianoRequestDataGetStationModes_t{}).station))
		case 4: return uintptr(offset_of(PianoRequestDataGetStationModes_t, retModes))
		case 5: return uintptr(size_of((PianoRequestDataGetStationModes_t{}).retModes))
		}
	case 27:
		switch property {
		case 0: return uintptr(size_of(PianoRequestDataSetStationMode_t))
		case 1: return uintptr(align_of(PianoRequestDataSetStationMode_t))
		case 2: return uintptr(offset_of(PianoRequestDataSetStationMode_t, station))
		case 3: return uintptr(size_of((PianoRequestDataSetStationMode_t{}).station))
		case 4: return uintptr(offset_of(PianoRequestDataSetStationMode_t, id))
		case 5: return uintptr(size_of((PianoRequestDataSetStationMode_t{}).id))
		}
	case 28:
		switch property {
		case 0: return uintptr(size_of(i32))
		case 1: return uintptr(align_of(i32))
		}
	case 29:
		switch property {
		case 0: return uintptr(size_of(i32))
		case 1: return uintptr(align_of(i32))
		}
	case 30:
		switch property {
		case 0: return uintptr(size_of(i32))
		case 1: return uintptr(align_of(i32))
		}
	case 31:
		switch property {
		case 0: return uintptr(size_of(i32))
		case 1: return uintptr(align_of(i32))
		}
	case 32:
		switch property {
		case 0: return uintptr(size_of(i32))
		case 1: return uintptr(align_of(i32))
		}
	case 33:
		switch property {
		case 0: return uintptr(size_of(i32))
		case 1: return uintptr(align_of(i32))
		}
	}
	return ~uintptr(0)
}
