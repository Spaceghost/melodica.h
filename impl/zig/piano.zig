// Native Zig implementation of the historical libpiano ABI.
// Protocol semantics follow PromyLOPh/pianobar ad5ec908 (MIT, Lars-Dominik Braun).
// json-c and libgcrypt are dependencies of this lane, never libpiano/melodica C.
const c = @cImport({
    @cDefine("_DEFAULT_SOURCE", "1");
    @cInclude("piano.h");
    @cInclude("json-c/json.h");
    @cInclude("gcrypt.h");
    @cInclude("stdlib.h");
    @cInclude("string.h");
    @cInclude("stdio.h");
    @cInclude("time.h");
});
const J = ?*c.json_object;
const Ret = c.PianoReturn_t;
const List = [*c]c.PianoListHead_t;

// Test introspection exposes this lane's actual compiled layouts, so the common
// C verifier checks the implementation rather than merely rechecking piano.h.
export fn melodica_piano_abi_layout(type_id: u32, property: u32) usize {
    const names = .{
        "PianoListHead_t", "PianoUserInfo_t", "PianoStation_t", "PianoSong_t",
        "PianoArtist_t", "PianoGenre_t", "PianoGenreCategory_t", "PianoPartner_t",
        "PianoHandle_t", "PianoSearchResult_t", "PianoStationInfo_t", "PianoSettings_t",
        "PianoStationMode_t", "PianoRequest_t", "PianoRequestDataLogin_t",
        "PianoRequestDataGetPlaylist_t", "PianoRequestDataRateSong_t",
        "PianoRequestDataAddFeedback_t", "PianoRequestDataRenameStation_t",
        "PianoRequestDataSearch_t", "PianoRequestDataCreateStation_t",
        "PianoRequestDataAddSeed_t", "PianoRequestDataExplain_t",
        "PianoRequestDataGetStationInfo_t", "PianoRequestDataDeleteSeed_t",
        "PianoRequestDataChangeSettings_t", "PianoRequestDataGetStationModes_t",
        "PianoRequestDataSetStationMode_t", "PianoSongRating_t", "PianoAudioFormat_t",
        "PianoAudioQuality_t", "PianoRequestType_t", "PianoTristate_t", "PianoReturn_t",
    };
    inline for (names, 0..) |name, id| {
        if (type_id == id) {
            const T = @field(c, name);
            if (property == 0) return @sizeOf(T);
            if (property == 1) return @alignOf(T);
            if (@typeInfo(T) == .@"struct") {
                inline for (@typeInfo(T).@"struct".fields, 0..) |field, n| {
                    if (property == 2 + 2 * n) return @offsetOf(T, field.name);
                    if (property == 3 + 2 * n) return @sizeOf(field.type);
                }
            }
        }
    }
    return ~@as(usize, 0);
}

fn as(comptime T: type, p: anytype) [*c]T {
    return @ptrCast(@alignCast(p));
}
fn new(comptime T: type) [*c]T {
    return as(T, c.calloc(1, @sizeOf(T)));
}
fn get(j: J, key: [*:0]const u8) J {
    var v: J = null;
    _ = c.json_object_object_get_ex(j, key, &v);
    return v;
}
fn has(j: J, key: [*:0]const u8) bool {
    return c.json_object_object_get_ex(j, key, null) != 0;
}
fn count(j: J) usize {
    return if (c.json_object_is_type(j, c.json_type_array) != 0) c.json_object_array_length(j) else 0;
}
fn at(j: J, i: usize) J {
    return c.json_object_array_get_idx(j, i);
}
fn str(j: J, key: [*:0]const u8) [*c]u8 {
    const s = c.json_object_get_string(get(j, key));
    return if (s == null) null else c.strdup(s);
}
fn integer(j: J, key: [*:0]const u8) c_int {
    return c.json_object_get_int(get(j, key));
}
fn boolean(j: J, key: [*:0]const u8, default: bool) bool {
    return if (has(j, key)) c.json_object_get_boolean(get(j, key)) != 0 else default;
}
fn add(j: J, key: [*:0]const u8, value: J) void {
    _ = c.json_object_object_add(j, key, value);
}
fn text(j: J, key: [*:0]const u8, value: [*c]const u8) void {
    add(j, key, c.json_object_new_string(value));
}
fn flag(j: J, key: [*:0]const u8, value: bool) void {
    add(j, key, c.json_object_new_boolean(@intFromBool(value)));
}
fn int(j: J, key: [*:0]const u8, value: c_int) void {
    add(j, key, c.json_object_new_int(value));
}
fn equal(a: [*c]const u8, b: [*c]const u8) bool {
    return a != null and b != null and c.strcmp(a, b) == 0;
}
fn append(comptime T: type, head: [*c]T, node: [*c]T) [*c]T {
    return as(T, PianoListAppend(as(c.PianoListHead_t, head), as(c.PianoListHead_t, node)));
}
export fn PianoListCount(l: [*c]const c.PianoListHead_t) usize {
    var n: usize = 0;
    var curr = l;
    while (curr != null) : (curr = curr.*.next) n += 1;
    return n;
}
export fn PianoListAppend(l: List, e: List) ?*anyopaque {
    if (e == null) return l;
    if (l == null) return e;
    var tail = l;
    while (tail.*.next != null) tail = tail.*.next;
    tail.*.next = e;
    return l;
}
export fn PianoListPrepend(l: List, e: List) ?*anyopaque {
    if (e == null) return l;
    e.*.next = l;
    return e;
}
export fn PianoListDelete(l: List, e: List) ?*anyopaque {
    var p = l;
    var prev: List = null;
    while (p != null) : (p = p.*.next) {
        if (p == e) {
            if (prev == null) return p.*.next;
            prev.*.next = p.*.next;
            break;
        }
        prev = p;
    }
    return l;
}
export fn PianoListGet(l: List, n: usize) ?*anyopaque {
    var p = l;
    var i: usize = 0;
    while (p != null and i < n) : (i += 1) p = p.*.next;
    return p;
}
fn destroyArtists(head: [*c]c.PianoArtist_t) void {
    var p = head;
    while (p != null) {
        const next = as(c.PianoArtist_t, p.*.head.next);
        inline for (.{ "name", "musicId", "seedId" }) |f| c.free(@field(p.*, f));
        c.free(p);
        p = next;
    }
}
fn destroyStation(p: [*c]c.PianoStation_t) void {
    inline for (.{ "name", "id", "seedId" }) |f| c.free(@field(p.*, f));
    _ = c.memset(p, 0, @sizeOf(c.PianoStation_t));
}
fn destroyStations(head: [*c]c.PianoStation_t) void {
    var p = head;
    while (p != null) {
        const next = as(c.PianoStation_t, p.*.head.next);
        destroyStation(p);
        c.free(p);
        p = next;
    }
}
export fn PianoDestroyPlaylist(head: [*c]c.PianoSong_t) void {
    var p = head;
    while (p != null) {
        const next = as(c.PianoSong_t, p.*.head.next);
        inline for (.{ "artist", "stationId", "album", "audioUrl", "coverArt", "musicId", "title", "seedId", "feedbackId", "detailUrl", "trackToken" }) |f| c.free(@field(p.*, f));
        c.free(p);
        p = next;
    }
}
export fn PianoDestroySearchResult(p: [*c]c.PianoSearchResult_t) void {
    if (p == null) return;
    destroyArtists(p.*.artists);
    PianoDestroyPlaylist(p.*.songs);
}
export fn PianoDestroyStationInfo(p: [*c]c.PianoStationInfo_t) void {
    if (p == null) return;
    PianoDestroyPlaylist(p.*.feedback);
    PianoDestroyPlaylist(p.*.songSeeds);
    destroyArtists(p.*.artistSeeds);
    destroyStations(p.*.stationSeeds);
}
export fn PianoDestroyStationMode(head: [*c]c.PianoStationMode_t) void {
    var p = head;
    while (p != null) {
        const next = as(c.PianoStationMode_t, p.*.head.next);
        c.free(p.*.name);
        c.free(p.*.description);
        c.free(p);
        p = next;
    }
}
export fn PianoInit(ph: [*c]c.PianoHandle_t, user: [*c]const u8, password: [*c]const u8, device: [*c]const u8, inkey: [*c]const u8, outkey: [*c]const u8) Ret {
    if (ph == null or user == null or password == null or device == null or inkey == null or outkey == null) return c.PIANO_RET_ERR;
    _ = c.memset(ph, 0, @sizeOf(c.PianoHandle_t));
    ph.*.partner.user = c.strdup(user);
    ph.*.partner.password = c.strdup(password);
    ph.*.partner.device = c.strdup(device);
    if (ph.*.partner.user == null or ph.*.partner.password == null or ph.*.partner.device == null) return c.PIANO_RET_OUT_OF_MEMORY;
    if (c.gcry_cipher_open(@ptrCast(&ph.*.partner.in), c.GCRY_CIPHER_BLOWFISH, c.GCRY_CIPHER_MODE_ECB, 0) != 0 or
        c.gcry_cipher_setkey(@ptrCast(ph.*.partner.in), inkey, c.strlen(inkey)) != 0 or
        c.gcry_cipher_open(@ptrCast(&ph.*.partner.out), c.GCRY_CIPHER_BLOWFISH, c.GCRY_CIPHER_MODE_ECB, 0) != 0 or
        c.gcry_cipher_setkey(@ptrCast(ph.*.partner.out), outkey, c.strlen(outkey)) != 0) return c.PIANO_RET_GCRY_ERR;
    return c.PIANO_RET_OK;
}
export fn PianoDestroy(ph: [*c]c.PianoHandle_t) void {
    if (ph == null) return;
    c.free(ph.*.user.authToken);
    c.free(ph.*.user.listenerId);
    destroyStations(ph.*.stations);
    inline for (.{ "user", "password", "device", "authToken" }) |f| c.free(@field(ph.*.partner, f));
    if (ph.*.partner.in != null) c.gcry_cipher_close(@ptrCast(ph.*.partner.in));
    if (ph.*.partner.out != null) c.gcry_cipher_close(@ptrCast(ph.*.partner.out));
    var cat = ph.*.genreStations;
    while (cat != null) {
        var genre = cat.*.genres;
        while (genre != null) {
            const next = as(c.PianoGenre_t, genre.*.head.next);
            c.free(genre.*.name);
            c.free(genre.*.musicId);
            c.free(genre);
            genre = next;
        }
        const next = as(c.PianoGenreCategory_t, cat.*.head.next);
        c.free(cat.*.name);
        c.free(cat);
        cat = next;
    }
    _ = c.memset(ph, 0, @sizeOf(c.PianoHandle_t));
}
export fn PianoDestroyRequest(req: [*c]c.PianoRequest_t) void {
    if (req == null) return;
    c.free(req.*.postData);
    _ = c.memset(req, 0, @sizeOf(c.PianoRequest_t));
}
export fn PianoFindStationById(stations: [*c]c.PianoStation_t, id: [*c]const u8) [*c]c.PianoStation_t {
    var p = stations;
    while (p != null) : (p = as(c.PianoStation_t, p.*.head.next)) if (equal(p.*.id, id)) return p;
    return null;
}
export fn PianoErrorToStr(ret: Ret) [*c]const u8 {
    return switch (ret) {
        c.PIANO_RET_OK => "Everything is fine :)",
        c.PIANO_RET_ERR => "Unknown.",
        c.PIANO_RET_INVALID_RESPONSE => "Invalid response.",
        c.PIANO_RET_CONTINUE_REQUEST => "Fix your program.",
        c.PIANO_RET_OUT_OF_MEMORY => "Out of memory.",
        c.PIANO_RET_INVALID_LOGIN => "Wrong email address or password.",
        c.PIANO_RET_QUALITY_UNAVAILABLE => "Selected audio quality is not available.",
        c.PIANO_RET_GCRY_ERR => "libgcrypt initialization failed.",
        c.PIANO_RET_P_INTERNAL => "Internal error.",
        c.PIANO_RET_P_CALL_NOT_ALLOWED => "Call not allowed.",
        c.PIANO_RET_P_INVALID_AUTH_TOKEN => "Invalid auth token.",
        c.PIANO_RET_P_MAINTENANCE_MODE => "Maintenance mode.",
        c.PIANO_RET_P_MAX_STATIONS_REACHED => "Max number of stations reached.",
        c.PIANO_RET_P_READ_ONLY_MODE => "Read only mode. Try again later.",
        c.PIANO_RET_P_STATION_DOES_NOT_EXIST => "Station does not exist.",
        c.PIANO_RET_P_INVALID_PARTNER_LOGIN => "Invalid partner login.",
        c.PIANO_RET_P_LICENSING_RESTRICTIONS => "Pandora is not available in your country. Set up a control proxy (see manpage).",
        c.PIANO_RET_P_PARTNER_NOT_AUTHORIZED => "Invalid partner credentials.",
        c.PIANO_RET_P_LISTENER_NOT_AUTHORIZED => "Listener not authorized.",
        c.PIANO_RET_P_RATE_LIMIT => "Access denied. Try again later.",
        else => "No error message available.",
    };
}
fn encrypt(h: ?*anyopaque, s: [*c]const u8) [*c]u8 {
    if (h == null or s == null) return null;
    const len = c.strlen(s);
    const padded = (len + 7) & ~@as(usize, 7);
    const input = as(u8, c.calloc(padded + 1, 1));
    if (input == null) return null;
    defer c.free(input);
    _ = c.memcpy(input, s, len);
    if (c.gcry_cipher_encrypt(@ptrCast(h), input, padded, null, 0) != 0) return null;
    const output = as(u8, c.calloc(padded * 2 + 1, 1));
    if (output == null) return null;
    for (0..padded) |i| {
        output[i * 2] = "0123456789abcdef"[input[i] >> 4];
        output[i * 2 + 1] = "0123456789abcdef"[input[i] & 15];
    }
    return output;
}
fn decrypt(h: ?*anyopaque, s: [*c]const u8, outlen: *usize) [*c]u8 {
    if (h == null or s == null) return null;
    const len = c.strlen(s);
    if (len % 16 != 0) return null;
    const bytes = len / 2;
    const out = as(u8, c.calloc(bytes + 1, 1));
    if (out == null) return null;
    for (0..bytes) |i| {
        // Upstream uses strtol per pair, including prefix parsing of malformed
        // pairs. This also preserves sign/whitespace behavior for valid bytes.
        var pair = [3]u8{ s[i * 2], s[i * 2 + 1], 0 };
        out[i] = @truncate(@as(u64, @bitCast(c.strtol(as(u8, &pair), null, 16))));
    }
    if (c.gcry_cipher_decrypt(@ptrCast(h), out, bytes, null, 0) != 0) {
        c.free(out);
        return null;
    }
    outlen.* = bytes;
    return out;
}
fn urlencode(s: [*c]const u8) [*c]u8 {
    if (s == null) return null;
    const len = c.strlen(s);
    const out = as(u8, c.malloc(len * 3 + 1));
    if (out == null) return null;
    var n: usize = 0;
    for (s[0..len]) |ch| {
        if ((ch >= 'a' and ch <= 'z') or (ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9') or ch == '-' or ch == '.' or ch == '_' or ch == '~') {
            out[n] = ch;
            n += 1;
        } else {
            out[n] = '%';
            out[n + 1] = "0123456789ABCDEF"[ch >> 4];
            out[n + 2] = "0123456789ABCDEF"[ch & 15];
            n += 3;
        }
    }
    out[n] = 0;
    return out;
}

export fn PianoRequest(ph: [*c]c.PianoHandle_t, req: [*c]c.PianoRequest_t, kind: c.PianoRequestType_t) Ret {
    if (ph == null or req == null) return c.PIANO_RET_ERR;
    req.*.type = kind;
    req.*.secure = false;
    const j = c.json_object_new_object() orelse return c.PIANO_RET_OUT_OF_MEMORY;
    defer _ = c.json_object_put(j);
    const timestamp: i32 = @truncate(c.time(null) -% ph.*.timeOffset);
    var method: ?[*:0]const u8 = null;
    var encrypted = true;
    if (req.*.data == null and kind != c.PIANO_REQUEST_GET_STATIONS and kind != c.PIANO_REQUEST_SET_QUICKMIX and kind != c.PIANO_REQUEST_GET_GENRE_STATIONS and kind != c.PIANO_REQUEST_GET_SETTINGS) return c.PIANO_RET_ERR;
    switch (kind) {
        c.PIANO_REQUEST_LOGIN => {
            const d = as(c.PianoRequestDataLogin_t, req.*.data);
            if (d.*.step == 0) {
                req.*.secure = true;
                encrypted = false;
                text(j, "username", ph.*.partner.user);
                text(j, "password", ph.*.partner.password);
                text(j, "deviceModel", ph.*.partner.device);
                text(j, "version", "5");
                flag(j, "includeUrls", true);
                _ = c.snprintf(as(u8, &req.*.urlPath), req.*.urlPath.len, "/services/json/?method=auth.partnerLogin");
            } else if (d.*.step == 1) {
                req.*.secure = true;
                text(j, "loginType", "user");
                text(j, "username", d.*.user);
                text(j, "password", d.*.password);
                text(j, "partnerAuthToken", ph.*.partner.authToken);
                int(j, "syncTime", timestamp);
                const token = urlencode(ph.*.partner.authToken);
                if (token == null) return c.PIANO_RET_OUT_OF_MEMORY;
                defer c.free(token);
                _ = c.snprintf(as(u8, &req.*.urlPath), req.*.urlPath.len, "/services/json/?method=auth.userLogin&auth_token=%s&partner_id=%i", token, @as(i32, @bitCast(ph.*.partner.id)));
            }
        },
        c.PIANO_REQUEST_GET_STATIONS => {
            flag(j, "returnAllStations", true);
            method = "user.getStationList";
        },
        c.PIANO_REQUEST_GET_PLAYLIST => {
            const d = as(c.PianoRequestDataGetPlaylist_t, req.*.data);
            if (d.*.station == null) return c.PIANO_RET_ERR;
            text(j, "stationToken", d.*.station.*.id);
            flag(j, "includeTrackLength", true);
            req.*.secure = true;
            method = "station.getPlaylist";
        },
        c.PIANO_REQUEST_ADD_FEEDBACK, c.PIANO_REQUEST_RATE_SONG => {
            if (kind == c.PIANO_REQUEST_ADD_FEEDBACK) {
                const d = as(c.PianoRequestDataAddFeedback_t, req.*.data);
                text(j, "stationToken", d.*.stationId);
                text(j, "trackToken", d.*.trackToken);
                flag(j, "isPositive", d.*.rating == c.PIANO_RATE_LOVE);
            } else {
                const d = as(c.PianoRequestDataRateSong_t, req.*.data);
                if (d.*.song == null) return c.PIANO_RET_ERR;
                text(j, "stationToken", d.*.song.*.stationId);
                text(j, "trackToken", d.*.song.*.trackToken);
                flag(j, "isPositive", d.*.rating == c.PIANO_RATE_LOVE);
            }
            method = "station.addFeedback";
        },
        c.PIANO_REQUEST_RENAME_STATION => {
            const d = as(c.PianoRequestDataRenameStation_t, req.*.data);
            if (d.*.station == null) return c.PIANO_RET_ERR;
            text(j, "stationToken", d.*.station.*.id);
            text(j, "stationName", d.*.newName);
            method = "station.renameStation";
        },
        c.PIANO_REQUEST_DELETE_STATION, c.PIANO_REQUEST_TRANSFORM_STATION => {
            const s = as(c.PianoStation_t, req.*.data);
            text(j, "stationToken", s.*.id);
            method = if (kind == c.PIANO_REQUEST_DELETE_STATION) "station.deleteStation" else "station.transformSharedStation";
        },
        c.PIANO_REQUEST_SEARCH => {
            text(j, "searchText", as(c.PianoRequestDataSearch_t, req.*.data).*.searchStr);
            method = "music.search";
        },
        c.PIANO_REQUEST_CREATE_STATION => {
            const d = as(c.PianoRequestDataCreateStation_t, req.*.data);
            if (d.*.type == c.PIANO_MUSICTYPE_INVALID) text(j, "musicToken", d.*.token) else {
                text(j, "trackToken", d.*.token);
                text(j, "musicType", if (d.*.type == c.PIANO_MUSICTYPE_SONG) "song" else "artist");
            }
            method = "station.createStation";
        },
        c.PIANO_REQUEST_ADD_SEED => {
            const d = as(c.PianoRequestDataAddSeed_t, req.*.data);
            if (d.*.station == null) return c.PIANO_RET_ERR;
            text(j, "musicToken", d.*.musicId);
            text(j, "stationToken", d.*.station.*.id);
            method = "station.addMusic";
        },
        c.PIANO_REQUEST_ADD_TIRED_SONG, c.PIANO_REQUEST_BOOKMARK_SONG, c.PIANO_REQUEST_BOOKMARK_ARTIST => {
            text(j, "trackToken", as(c.PianoSong_t, req.*.data).*.trackToken);
            method = switch (kind) {
                c.PIANO_REQUEST_ADD_TIRED_SONG => "user.sleepSong",
                c.PIANO_REQUEST_BOOKMARK_SONG => "bookmark.addSongBookmark",
                else => "bookmark.addArtistBookmark",
            };
        },
        c.PIANO_REQUEST_SET_QUICKMIX => {
            const a = c.json_object_new_array();
            var s = ph.*.stations;
            while (s != null) : (s = as(c.PianoStation_t, s.*.head.next)) {
                if (s.*.useQuickMix != 0 and s.*.isQuickMix == 0) _ = c.json_object_array_add(a, c.json_object_new_string(s.*.id));
            }
            add(j, "quickMixStationIds", a);
            method = "user.setQuickMix";
        },
        c.PIANO_REQUEST_GET_GENRE_STATIONS => method = "station.getGenreStations",
        c.PIANO_REQUEST_EXPLAIN => {
            const d = as(c.PianoRequestDataExplain_t, req.*.data);
            if (d.*.song == null) return c.PIANO_RET_ERR;
            text(j, "trackToken", d.*.song.*.trackToken);
            method = "track.explainTrack";
        },
        c.PIANO_REQUEST_GET_STATION_INFO => {
            const d = as(c.PianoRequestDataGetStationInfo_t, req.*.data);
            if (d.*.station == null) return c.PIANO_RET_ERR;
            text(j, "stationToken", d.*.station.*.id);
            flag(j, "includeExtendedAttributes", true);
            flag(j, "includeExtraParams", true);
            method = "station.getStation";
        },
        c.PIANO_REQUEST_GET_STATION_MODES => {
            const d = as(c.PianoRequestDataGetStationModes_t, req.*.data);
            if (d.*.station == null) return c.PIANO_RET_ERR;
            text(j, "stationId", d.*.station.*.id);
            req.*.secure = true;
            method = "interactiveradio.v1.getAvailableModesSimple";
        },
        c.PIANO_REQUEST_SET_STATION_MODE => {
            const d = as(c.PianoRequestDataSetStationMode_t, req.*.data);
            if (d.*.station == null) return c.PIANO_RET_ERR;
            text(j, "stationId", d.*.station.*.id);
            int(j, "modeId", @bitCast(d.*.id));
            req.*.secure = true;
            method = "interactiveradio.v1.setAndGetAvailableModes";
        },
        c.PIANO_REQUEST_DELETE_FEEDBACK => {
            text(j, "feedbackId", as(c.PianoSong_t, req.*.data).*.feedbackId);
            method = "station.deleteFeedback";
        },
        c.PIANO_REQUEST_DELETE_SEED => {
            const d = as(c.PianoRequestDataDeleteSeed_t, req.*.data);
            const id = if (d.*.song != null) d.*.song.*.seedId else if (d.*.artist != null) d.*.artist.*.seedId else if (d.*.station != null) d.*.station.*.seedId else null;
            if (id == null) return c.PIANO_RET_ERR;
            text(j, "seedId", id);
            method = "station.deleteMusic";
        },
        c.PIANO_REQUEST_GET_SETTINGS => method = "user.getSettings",
        c.PIANO_REQUEST_CHANGE_SETTINGS => {
            const d = as(c.PianoRequestDataChangeSettings_t, req.*.data);
            flag(j, "userInitiatedChange", true);
            text(j, "currentUsername", d.*.currentUsername);
            text(j, "currentPassword", d.*.currentPassword);
            if (d.*.explicitContentFilter != c.PIANO_UNDEFINED) flag(j, "isExplicitContentFilterEnabled", d.*.explicitContentFilter == c.PIANO_TRUE);
            if (d.*.newUsername != null) text(j, "newUsername", d.*.newUsername);
            if (d.*.newPassword != null) text(j, "newPassword", d.*.newPassword);
            method = "user.changeSettings";
            req.*.secure = true;
        },
        else => return c.PIANO_RET_ERR,
    }
    if (method) |m| {
        if (ph.*.user.authToken == null or ph.*.user.listenerId == null) return c.PIANO_RET_ERR;
        const token = urlencode(ph.*.user.authToken);
        if (token == null) return c.PIANO_RET_OUT_OF_MEMORY;
        defer c.free(token);
        _ = c.snprintf(as(u8, &req.*.urlPath), req.*.urlPath.len, "/services/json/?method=%s&auth_token=%s&partner_id=%i&user_id=%s", m, token, @as(i32, @bitCast(ph.*.partner.id)), ph.*.user.listenerId);
        text(j, "userAuthToken", ph.*.user.authToken);
        int(j, "syncTime", timestamp);
    }
    const wire = c.json_object_to_json_string(j);
    req.*.postData = if (encrypted) encrypt(ph.*.partner.out, wire) else c.strdup(wire);
    return if (req.*.postData == null) c.PIANO_RET_OUT_OF_MEMORY else c.PIANO_RET_OK;
}

fn parseStation(j: J, s: [*c]c.PianoStation_t) void {
    s.*.name = str(j, "stationName");
    s.*.id = str(j, "stationToken");
    s.*.isCreator = @intFromBool(!boolean(j, "isShared", true));
    s.*.isQuickMix = @intFromBool(boolean(j, "isQuickMix", false));
}
fn song(j: J, kind: enum { playlist, search, seed, feedback }) [*c]c.PianoSong_t {
    const s = new(c.PianoSong_t);
    if (s == null) return null;
    s.*.artist = str(j, "artistName");
    s.*.title = str(j, "songName");
    switch (kind) {
        .playlist => {
            s.*.album = str(j, "albumName");
            s.*.trackToken = str(j, "trackToken");
            s.*.stationId = str(j, "stationId");
            s.*.coverArt = str(j, "albumArtUrl");
            s.*.detailUrl = str(j, "songDetailUrl");
            s.*.fileGain = @floatCast(c.json_object_get_double(get(j, "trackGain")));
            s.*.length = @bitCast(integer(j, "trackLength"));
            s.*.rating = if (integer(j, "songRating") == 1) c.PIANO_RATE_LOVE else c.PIANO_RATE_NONE;
        },
        .search => s.*.musicId = str(j, "musicToken"),
        .seed => s.*.seedId = str(j, "seedId"),
        .feedback => {
            s.*.feedbackId = str(j, "feedbackId");
            s.*.rating = if (boolean(j, "isPositive", false)) c.PIANO_RATE_LOVE else c.PIANO_RATE_BAN;
            s.*.length = @bitCast(integer(j, "trackLength"));
        },
    }
    return s;
}
fn artist(j: J, seed: bool) [*c]c.PianoArtist_t {
    const a = new(c.PianoArtist_t);
    if (a == null) return null;
    a.*.name = str(j, "artistName");
    if (seed) a.*.seedId = str(j, "seedId") else a.*.musicId = str(j, "musicToken");
    return a;
}
fn boundedConcat(dst: [*c]u8, s: [*c]const u8, cap: usize) void {
    if (s == null) return;
    const n = c.strlen(dst);
    if (n < cap - 1) _ = c.strncat(dst, s, cap - n - 1);
}
export fn PianoResponse(ph: [*c]c.PianoHandle_t, req: [*c]c.PianoRequest_t) Ret {
    if (ph == null or req == null or req.*.responseData == null) return c.PIANO_RET_INVALID_RESPONSE;
    const j = c.json_tokener_parse(req.*.responseData) orelse return c.PIANO_RET_INVALID_RESPONSE;
    defer _ = c.json_object_put(j);
    const status = c.json_object_get_string(get(j, "stat"));
    if (status == null) return c.PIANO_RET_INVALID_RESPONSE;
    if (!equal(status, "ok")) {
        if (!has(j, "code")) return c.PIANO_RET_INVALID_RESPONSE;
        const code: u32 = @bitCast(integer(j, "code") +% c.PIANO_RET_OFFSET);
        if (code == c.PIANO_RET_P_INVALID_PARTNER_LOGIN and req.*.type == c.PIANO_REQUEST_LOGIN and req.*.data != null and as(c.PianoRequestDataLogin_t, req.*.data).*.step == 1) return c.PIANO_RET_INVALID_LOGIN;
        return code;
    }
    const r = get(j, "result");
    switch (req.*.type) {
        c.PIANO_REQUEST_LOGIN => {
            const d = as(c.PianoRequestDataLogin_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            if (d.*.step == 0) {
                const timestamp = c.json_object_get_string(get(r, "syncTime"));
                if (timestamp == null) return c.PIANO_RET_INVALID_RESPONSE;
                var n: usize = 0;
                const plain = decrypt(ph.*.partner.in, timestamp, &n);
                var ret: Ret = c.PIANO_RET_ERR;
                if (plain != null) {
                    if (n > 4) {
                        ph.*.timeOffset = @truncate(c.time(null) -% @as(i64, @bitCast(c.strtoul(plain + 4, null, 0))));
                        ret = c.PIANO_RET_CONTINUE_REQUEST;
                    }
                    c.free(plain);
                }
                ph.*.partner.authToken = str(r, "partnerAuthToken");
                if (!has(r, "partnerId")) return c.PIANO_RET_INVALID_RESPONSE;
                ph.*.partner.id = @bitCast(integer(r, "partnerId"));
                d.*.step +%= 1;
                return ret;
            } else if (d.*.step == 1) {
                if (ph.*.user.listenerId != null) {
                    c.free(ph.*.user.listenerId);
                    c.free(ph.*.user.authToken);
                }
                ph.*.user.listenerId = str(r, "userId");
                ph.*.user.authToken = str(r, "userAuthToken");
            }
        },
        c.PIANO_REQUEST_GET_STATIONS => {
            const items = get(r, "stations");
            var mix: J = null;
            for (0..count(items)) |i| {
                const item = at(items, i);
                const s = new(c.PianoStation_t);
                if (s == null) return c.PIANO_RET_OUT_OF_MEMORY;
                parseStation(item, s);
                if (s.*.isQuickMix != 0) mix = get(item, "quickMixStationIds");
                ph.*.stations = append(c.PianoStation_t, ph.*.stations, s);
            }
            var s = ph.*.stations;
            while (s != null) : (s = as(c.PianoStation_t, s.*.head.next)) for (0..count(mix)) |i| {
                if (equal(s.*.id, c.json_object_get_string(at(mix, i)))) s.*.useQuickMix = 1;
            };
        },
        c.PIANO_REQUEST_GET_PLAYLIST => {
            const d = as(c.PianoRequestDataGetPlaylist_t, req.*.data);
            if (d == null or d.*.quality < 1 or d.*.quality > 3) return c.PIANO_RET_INVALID_RESPONSE;
            if (!has(r, "items")) return c.PIANO_RET_OK;
            const items = get(r, "items");
            var list: [*c]c.PianoSong_t = null;
            for (0..count(items)) |i| {
                const item = at(items, i);
                if (!has(item, "artistName")) continue;
                const s = song(item, .playlist);
                if (s == null) {
                    PianoDestroyPlaylist(list);
                    return c.PIANO_RET_OUT_OF_MEMORY;
                }
                if (has(item, "audioUrlMap")) {
                    const quality = [_][*:0]const u8{ "", "lowQuality", "mediumQuality", "highQuality" };
                    const q = get(get(item, "audioUrlMap"), quality[d.*.quality]);
                    const encoding = c.json_object_get_string(get(q, "encoding"));
                    if (encoding == null) {
                        PianoDestroyPlaylist(s);
                        PianoDestroyPlaylist(list);
                        return c.PIANO_RET_QUALITY_UNAVAILABLE;
                    }
                    s.*.audioFormat = if (equal(encoding, "aacplus")) c.PIANO_AF_AACPLUS else if (equal(encoding, "mp3")) c.PIANO_AF_MP3 else c.PIANO_AF_UNKNOWN;
                    s.*.audioUrl = str(q, "audioUrl");
                }
                list = append(c.PianoSong_t, list, s);
            }
            d.*.retPlaylist = list;
        },
        c.PIANO_REQUEST_RATE_SONG => {
            const d = as(c.PianoRequestDataRateSong_t, req.*.data);
            if (d == null or d.*.song == null) return c.PIANO_RET_INVALID_RESPONSE;
            d.*.song.*.rating = d.*.rating;
        },
        c.PIANO_REQUEST_ADD_FEEDBACK => return c.PIANO_RET_ERR,
        c.PIANO_REQUEST_RENAME_STATION => {
            const d = as(c.PianoRequestDataRenameStation_t, req.*.data);
            if (d == null or d.*.station == null or d.*.newName == null) return c.PIANO_RET_INVALID_RESPONSE;
            const name = c.strdup(d.*.newName);
            if (name == null) return c.PIANO_RET_OUT_OF_MEMORY;
            c.free(d.*.station.*.name);
            d.*.station.*.name = name;
        },
        c.PIANO_REQUEST_DELETE_STATION => {
            const s = as(c.PianoStation_t, req.*.data);
            if (s == null) return c.PIANO_RET_INVALID_RESPONSE;
            ph.*.stations = as(c.PianoStation_t, PianoListDelete(as(c.PianoListHead_t, ph.*.stations), &s.*.head));
            destroyStation(s);
            c.free(s);
        },
        c.PIANO_REQUEST_SEARCH => {
            const d = as(c.PianoRequestDataSearch_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            _ = c.memset(&d.*.searchResult, 0, @sizeOf(c.PianoSearchResult_t));
            const artists = get(r, "artists");
            for (0..count(artists)) |i| {
                const a = artist(at(artists, i), false);
                if (a == null) return c.PIANO_RET_OUT_OF_MEMORY;
                d.*.searchResult.artists = append(c.PianoArtist_t, d.*.searchResult.artists, a);
            }
            const songs = get(r, "songs");
            for (0..count(songs)) |i| {
                const s = song(at(songs, i), .search);
                if (s == null) return c.PIANO_RET_OUT_OF_MEMORY;
                d.*.searchResult.songs = append(c.PianoSong_t, d.*.searchResult.songs, s);
            }
        },
        c.PIANO_REQUEST_CREATE_STATION => {
            const s = new(c.PianoStation_t);
            if (s == null) return c.PIANO_RET_OUT_OF_MEMORY;
            parseStation(r, s);
            const old = PianoFindStationById(ph.*.stations, s.*.id);
            if (old != null) {
                ph.*.stations = as(c.PianoStation_t, PianoListDelete(as(c.PianoListHead_t, ph.*.stations), &old.*.head));
                destroyStation(old);
                c.free(old);
            }
            ph.*.stations = append(c.PianoStation_t, ph.*.stations, s);
        },
        c.PIANO_REQUEST_ADD_TIRED_SONG => {
            const s = as(c.PianoSong_t, req.*.data);
            if (s == null) return c.PIANO_RET_INVALID_RESPONSE;
            s.*.rating = c.PIANO_RATE_TIRED;
        },
        c.PIANO_REQUEST_ADD_SEED, c.PIANO_REQUEST_SET_QUICKMIX, c.PIANO_REQUEST_BOOKMARK_SONG, c.PIANO_REQUEST_BOOKMARK_ARTIST, c.PIANO_REQUEST_DELETE_FEEDBACK, c.PIANO_REQUEST_DELETE_SEED, c.PIANO_REQUEST_CHANGE_SETTINGS => {},
        c.PIANO_REQUEST_GET_GENRE_STATIONS => {
            const cats = get(r, "categories");
            for (0..count(cats)) |i| {
                const item = at(cats, i);
                const cat = new(c.PianoGenreCategory_t);
                if (cat == null) return c.PIANO_RET_OUT_OF_MEMORY;
                cat.*.name = str(item, "categoryName");
                ph.*.genreStations = append(c.PianoGenreCategory_t, ph.*.genreStations, cat);
                const genres = get(item, "stations");
                for (0..count(genres)) |k| {
                    const g = new(c.PianoGenre_t);
                    if (g == null) return c.PIANO_RET_OUT_OF_MEMORY;
                    g.*.name = str(at(genres, k), "stationName");
                    g.*.musicId = str(at(genres, k), "stationToken");
                    cat.*.genres = append(c.PianoGenre_t, cat.*.genres, g);
                }
            }
        },
        c.PIANO_REQUEST_TRANSFORM_STATION => {
            const s = as(c.PianoStation_t, req.*.data);
            if (s == null) return c.PIANO_RET_INVALID_RESPONSE;
            s.*.isCreator = 1;
        },
        c.PIANO_REQUEST_EXPLAIN => {
            const d = as(c.PianoRequestDataExplain_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            const e = get(r, "explanations");
            const n = count(e);
            if (n > 0) {
                const out = as(u8, c.calloc(768, 1));
                if (out == null) return c.PIANO_RET_OUT_OF_MEMORY;
                boundedConcat(out, "We're playing this track because it features ", 768);
                for (0..n) |i| {
                    if (!has(at(e, i), "focusTraitName")) continue;
                    boundedConcat(out, c.json_object_get_string(get(at(e, i), "focusTraitName")), 768);
                    boundedConcat(out, if (i < n -% 2) ", " else if (i == n -% 2) " and " else ".", 768);
                }
                d.*.retExplain = out;
            }
        },
        c.PIANO_REQUEST_GET_SETTINGS => {
            const d = as(c.PianoSettings_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            d.*.explicitContentFilter = boolean(r, "isExplicitContentFilterEnabled", false);
            d.*.username = str(r, "username");
        },
        c.PIANO_REQUEST_GET_STATION_INFO => {
            const d = as(c.PianoRequestDataGetStationInfo_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            const music = get(r, "music");
            const songs = get(music, "songs");
            for (0..count(songs)) |i| {
                const s = song(at(songs, i), .seed);
                if (s == null) return c.PIANO_RET_OUT_OF_MEMORY;
                d.*.info.songSeeds = append(c.PianoSong_t, d.*.info.songSeeds, s);
            }
            const artists = get(music, "artists");
            for (0..count(artists)) |i| {
                const a = artist(at(artists, i), true);
                if (a == null) return c.PIANO_RET_OUT_OF_MEMORY;
                d.*.info.artistSeeds = append(c.PianoArtist_t, d.*.info.artistSeeds, a);
            }
            const feedback = get(r, "feedback");
            inline for (.{ "thumbsUp", "thumbsDown" }) |key| {
                const entries = get(feedback, key);
                for (0..count(entries)) |i| {
                    const s = song(at(entries, i), .feedback);
                    if (s == null) return c.PIANO_RET_OUT_OF_MEMORY;
                    d.*.info.feedback = append(c.PianoSong_t, d.*.info.feedback, s);
                }
            }
        },
        c.PIANO_REQUEST_GET_STATION_MODES => {
            const d = as(c.PianoRequestDataGetStationModes_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            const active = if (has(r, "currentModeId")) integer(r, "currentModeId") else -1;
            const modes = get(r, "availableModes");
            for (0..count(modes)) |i| {
                const item = at(modes, i);
                const m = new(c.PianoStationMode_t);
                if (m == null) return c.PIANO_RET_OUT_OF_MEMORY;
                if (has(item, "modeId")) {
                    m.*.id = integer(item, "modeId");
                    m.*.name = str(item, "modeName");
                    m.*.description = str(item, "modeDescription");
                    m.*.isAlgorithmic = boolean(item, "isAlgorithmicMode", false);
                    m.*.isTakeover = boolean(item, "isTakeoverMode", false);
                    m.*.active = active == m.*.id;
                }
                d.*.retModes = append(c.PianoStationMode_t, d.*.retModes, m);
            }
        },
        c.PIANO_REQUEST_SET_STATION_MODE => {
            const d = as(c.PianoRequestDataSetStationMode_t, req.*.data);
            if (d == null) return c.PIANO_RET_INVALID_RESPONSE;
            const active: i32 = if (has(r, "currentModeId")) integer(r, "currentModeId") else -1;
            if (@as(u32, @bitCast(active)) != d.*.id) return c.PIANO_RET_ERR;
        },
        else => return c.PIANO_RET_ERR,
    }
    return c.PIANO_RET_OK;
}
