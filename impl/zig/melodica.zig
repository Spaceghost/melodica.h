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
    return "0123456789ABCDEF"[n];
}

inline fn jsonExtra(c: u8) usize {
    if (c >= 0x20) return if (c == '"' or c == '\\') 1 else 0;
    return switch (c) {
        '\x08', '\x0c', '\n', '\r', '\t' => 1,
        else => 5,
    };
}

inline fn copyBytes(dst: [*]u8, src: [*]const u8, src_len: usize) void {
    const dst_address = @intFromPtr(dst);
    const src_address = @intFromPtr(src);
    const disjoint = if (dst_address < src_address)
        src_address - dst_address >= src_len
    else
        dst_address - src_address >= src_len;
    if (disjoint) {
        @memcpy(dst[0..src_len], src[0..src_len]);
        return;
    }
    // Preserve forward-copy behavior for overlapping source/destination spans.
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

// Packed bytes avoid alignment assumptions and preserve all high UTF-8 bytes.
inline fn jsonPlain4(src: [*]const u8) bool {
    const word = @as(u32, src[0]) | (@as(u32, src[1]) << 8) |
        (@as(u32, src[2]) << 16) | (@as(u32, src[3]) << 24);
    const quotes = word ^ 0x22222222;
    const slashes = word ^ 0x5c5c5c5c;
    const controls = (word -% 0x20202020) & ~word;
    const quote_zero = (quotes -% 0x01010101) & ~quotes;
    const slash_zero = (slashes -% 0x01010101) & ~slashes;
    return ((controls | quote_zero | slash_zero) & 0x80808080) == 0;
}

inline fn jsonEscapeSizeImpl(src: [*]const u8, src_len: usize) usize {
    var required = src_len;
    var i: usize = 0;
    while (src_len - i >= 4 and jsonPlain4(src + i)) : (i += 4) {}
    while (i < src_len) : (i += 1) {
        const c = src[i];
        if (c == '"' or c == '\\') {
            required += 1;
        } else if (c < 0x20) {
            required += jsonExtra(c);
        }
    }
    return required;
}

inline fn writeJson(dst: [*]u8, out_in: usize, src: [*]const u8, src_len: usize) usize {
    var out = out_in;
    var i: usize = 0;
    while (i < src_len) : (i += 1) {
        const c = src[i];
        if (c >= 0x20) {
            if (c == '"' or c == '\\') {
                dst[out] = '\\';
                dst[out + 1] = c;
                out += 2;
            } else {
                dst[out] = c;
                out += 1;
            }
            continue;
        }
        switch (c) {
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
    while (value >= 10000) : (value /= 10000) digits += 4;
    if (value >= 1000) return digits + 3;
    if (value >= 100) return digits + 2;
    if (value >= 10) return digits + 1;
    return digits;
}

inline fn writeDecimal(dst: [*]u8, out_in: usize, value_in: usize) usize {
    var digits: [3 * @sizeOf(usize)]u8 = undefined;
    var count: usize = 0;
    var value = value_in;
    while (value >= 100) {
        const pair = value % 100;
        value /= 100;
        digits[count] = '0' + @as(u8, @intCast(pair % 10));
        digits[count + 1] = '0' + @as(u8, @intCast(pair / 10));
        count += 2;
    }
    if (value >= 10) {
        digits[count] = '0' + @as(u8, @intCast(value % 10));
        digits[count + 1] = '0' + @as(u8, @intCast(value / 10));
        count += 2;
    } else {
        digits[count] = '0' + @as(u8, @intCast(value));
        count += 1;
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
    const auth_required = jsonEscapeSizeImpl(auth, auth_len);
    const required = station_prefix.len + auth_required +
        station_suffix.len + decimalSize(sync_time) + 1;
    if (dst_opt == null or dst_cap < required) return required;
    const dst = dst_opt.?;

    var out: usize = 0;
    for (station_prefix) |c| { dst[out] = c; out += 1; }
    if (auth_required == auth_len) {
        copyBytes(dst + out, auth, auth_len);
        out += auth_len;
    } else {
        out = writeJson(dst, out, auth, auth_len);
    }
    for (station_suffix) |c| { dst[out] = c; out += 1; }
    out = writeDecimal(dst, out, sync_time);
    dst[out] = '}';
    return required;
}
