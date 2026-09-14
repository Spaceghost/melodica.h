const ABI_VERSION: u32 = 1;
const station_prefix = "{\"returnAllStations\":true,\"userAuthToken\":\"";
const station_suffix = "\",\"syncTime\":";

inline fn isUnreserved(c: u8) bool {
    return (c >= 'A' and c <= 'Z') or
        (c >= 'a' and c <= 'z') or
        (c >= '0' and c <= '9') or
        c == '-' or c == '.' or c == '_' or c == '~';
}

inline fn hexDigit(n: u8) u8 {
    return if (n < 10) '0' + n else 'A' + (n - 10);
}

inline fn jsonExtra(c: u8) usize {
    if (c >= 0x20) return if (c == '"' or c == '\\') 1 else 0;
    return switch (c) {
        '\x08', '\x0c', '\n', '\r', '\t' => 1,
        else => 5,
    };
}

inline fn copyBytes(dst: [*]u8, src: [*]const u8, src_len: usize) void {
    var i: usize = 0;
    while (i < src_len) : (i += 1) dst[i] = src[i];
}

inline fn urlEncodeSizeImpl(src: [*]const u8, src_len: usize) usize {
    var required: usize = 0;
    var i: usize = 0;
    while (i < src_len) : (i += 1) {
        required += if (isUnreserved(src[i])) 1 else 3;
    }
    return required;
}

inline fn writeUrl(dst: [*]u8, src: [*]const u8, src_len: usize) usize {
    var out: usize = 0;
    var i: usize = 0;
    while (i < src_len) : (i += 1) {
        const c = src[i];
        if (isUnreserved(c)) {
            dst[out] = c;
            out += 1;
        } else {
            dst[out] = '%';
            dst[out + 1] = hexDigit(c >> 4);
            dst[out + 2] = hexDigit(c & 0x0f);
            out += 3;
        }
    }
    return out;
}

inline fn jsonEscapeSizeImpl(src: [*]const u8, src_len: usize) usize {
    var required = src_len;
    var i: usize = 0;
    while (i < src_len) : (i += 1) required += jsonExtra(src[i]);
    return required;
}

inline fn writeJson(dst: [*]u8, out_in: usize, src: [*]const u8, src_len: usize) usize {
    var out = out_in;
    var i: usize = 0;
    while (i < src_len) : (i += 1) {
        const c = src[i];
        if (c >= 0x20 and c != '"' and c != '\\') {
            dst[out] = c;
            out += 1;
            continue;
        }
        switch (c) {
            '"' => { dst[out] = '\\'; dst[out + 1] = '"'; out += 2; },
            '\\' => { dst[out] = '\\'; dst[out + 1] = '\\'; out += 2; },
            '\x08' => { dst[out] = '\\'; dst[out + 1] = 'b'; out += 2; },
            '\x0c' => { dst[out] = '\\'; dst[out + 1] = 'f'; out += 2; },
            '\n' => { dst[out] = '\\'; dst[out + 1] = 'n'; out += 2; },
            '\r' => { dst[out] = '\\'; dst[out + 1] = 'r'; out += 2; },
            '\t' => { dst[out] = '\\'; dst[out + 1] = 't'; out += 2; },
            else => {
                dst[out] = '\\';
                dst[out + 1] = 'u';
                dst[out + 2] = '0';
                dst[out + 3] = '0';
                dst[out + 4] = hexDigit(c >> 4);
                dst[out + 5] = hexDigit(c & 0x0f);
                out += 6;
            },
        }
    }
    return out;
}

inline fn decimalSize(value_in: usize) usize {
    var value = value_in;
    var digits: usize = 1;
    while (value >= 10) : (value /= 10) digits += 1;
    return digits;
}

inline fn writeDecimal(dst: [*]u8, out_in: usize, value_in: usize) usize {
    var digits: [3 * @sizeOf(usize)]u8 = undefined;
    var count: usize = 0;
    var value = value_in;
    while (true) {
        digits[count] = '0' + @as(u8, @intCast(value % 10));
        count += 1;
        value /= 10;
        if (value == 0) break;
    }

    var out = out_in;
    while (count != 0) {
        count -= 1;
        dst[out] = digits[count];
        out += 1;
    }
    return out;
}

inline fn stationListRequestSizeImpl(
    auth: [*]const u8,
    auth_len: usize,
    sync_time: usize,
) usize {
    return station_prefix.len + jsonEscapeSizeImpl(auth, auth_len) +
        station_suffix.len + decimalSize(sync_time) + 1;
}

export fn melodica_abi_version() u32 {
    return ABI_VERSION;
}

export fn melodica_url_encode_size(src_opt: ?[*]const u8, src_len: usize) usize {
    const src = src_opt orelse return 0;
    return urlEncodeSizeImpl(src, src_len);
}

export fn melodica_url_encode(
    dst_opt: ?[*]u8,
    dst_cap: usize,
    src_opt: ?[*]const u8,
    src_len: usize,
) usize {
    const src = src_opt orelse return 0;
    if (dst_opt) |dst| {
        if (src_len <= dst_cap / 3) return writeUrl(dst, src, src_len);
    }

    const required = urlEncodeSizeImpl(src, src_len);
    if (dst_opt == null or dst_cap < required) return required;
    const dst = dst_opt.?;
    if (required == src_len) {
        copyBytes(dst, src, src_len);
        return required;
    }
    _ = writeUrl(dst, src, src_len);
    return required;
}

export fn melodica_json_escape_size(src_opt: ?[*]const u8, src_len: usize) usize {
    const src = src_opt orelse return 0;
    return jsonEscapeSizeImpl(src, src_len);
}

export fn melodica_json_escape(
    dst_opt: ?[*]u8,
    dst_cap: usize,
    src_opt: ?[*]const u8,
    src_len: usize,
) usize {
    const src = src_opt orelse return 0;
    if (dst_opt) |dst| {
        if (src_len <= dst_cap / 6) return writeJson(dst, 0, src, src_len);
    }

    const required = jsonEscapeSizeImpl(src, src_len);
    if (dst_opt == null or dst_cap < required) return required;
    const dst = dst_opt.?;
    if (required == src_len) {
        copyBytes(dst, src, src_len);
        return required;
    }
    _ = writeJson(dst, 0, src, src_len);
    return required;
}

export fn melodica_station_list_request_size(
    auth_opt: ?[*]const u8,
    auth_len: usize,
    sync_time: usize,
) usize {
    const auth = auth_opt orelse return 0;
    return stationListRequestSizeImpl(auth, auth_len, sync_time);
}

export fn melodica_station_list_request(
    dst_opt: ?[*]u8,
    dst_cap: usize,
    auth_opt: ?[*]const u8,
    auth_len: usize,
    sync_time: usize,
) usize {
    const auth = auth_opt orelse return 0;
    const required = stationListRequestSizeImpl(auth, auth_len, sync_time);
    if (dst_opt == null or dst_cap < required) return required;
    const dst = dst_opt.?;

    var out: usize = 0;
    for (station_prefix) |c| { dst[out] = c; out += 1; }
    out = writeJson(dst, out, auth, auth_len);
    for (station_suffix) |c| { dst[out] = c; out += 1; }
    out = writeDecimal(dst, out, sync_time);
    dst[out] = '}';
    return required;
}
