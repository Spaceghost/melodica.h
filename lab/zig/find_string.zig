fn isWs(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r';
}

fn isHex(c: u8) bool {
    return (c >= '0' and c <= '9') or
        (c >= 'a' and c <= 'f') or
        (c >= 'A' and c <= 'F');
}

fn boundary(json: []const u8, pos: usize) bool {
    if (pos >= json.len) return true;
    const c = json[pos];
    return isWs(c) or c == ',' or c == ']' or c == '}';
}

fn quoteIsEscaped(json: []const u8, pos0: usize) bool {
    if (pos0 == 0) return false;
    var pos = pos0;
    var n: usize = 0;
    while (pos > 0) {
        pos -= 1;
        if (json[pos] != '\\') break;
        n += 1;
    }
    return (n & 1) != 0;
}

fn skipWs(json: []const u8, pos0: usize) usize {
    var pos = pos0;
    while (pos < json.len and isWs(json[pos])) pos += 1;
    return pos;
}

fn parseString(json: []const u8, pos0: usize, off: *usize, out_len: *usize) i32 {
    var pos = skipWs(json, pos0);
    if (pos >= json.len or json[pos] != '"') return 2;
    pos += 1;
    const start = pos;

    while (pos < json.len) {
        const c = json[pos];
        if (c == '\\') {
            pos += 1;
            if (pos >= json.len) return 2;
            const e = json[pos];
            if (e == 'u') {
                if (pos + 4 >= json.len or !isHex(json[pos+1]) or
                    !isHex(json[pos+2]) or !isHex(json[pos+3]) or
                    !isHex(json[pos+4])) return 2;
                pos += 5;
                continue;
            }
            if (!(e == '"' or e == '\\' or e == '/' or e == 'b' or
                e == 'f' or e == 'n' or e == 'r' or e == 't')) return 2;
            pos += 1;
            continue;
        }
        if (c == '"') {
            if (!boundary(json, pos + 1)) return 2;
            off.* = start;
            out_len.* = pos - start;
            return 0;
        }
        if (c < 0x20) return 2;
        pos += 1;
    }
    return 2;
}

export fn lab_find_string(
    json_ptr_opt: ?[*]const u8,
    json_len: usize,
    key_ptr_opt: ?[*]const u8,
    key_len: usize,
    off_opt: ?*usize,
    out_len_opt: ?*usize,
) callconv(.c) i32 {
    const json_ptr = json_ptr_opt orelse return 4;
    const key_ptr = key_ptr_opt orelse return 4;
    const off = off_opt orelse return 4;
    const out_len = out_len_opt orelse return 4;
    const json = json_ptr[0..json_len];
    const key = key_ptr[0..key_len];
    if (key_len + 2 > json_len) return 1;

    var i: usize = 0;
    while (i + key_len + 2 <= json_len) : (i += 1) {
        if (json[i] != '"' or quoteIsEscaped(json, i)) continue;
        var k: usize = 0;
        while (k < key_len and json[i+1+k] == key[k]) : (k += 1) {}
        if (k != key_len or json[i+1+key_len] != '"') continue;
        const after = skipWs(json, i + key_len + 2);
        if (after < json_len and json[after] == ':')
            return parseString(json, after + 1, off, out_len);
    }
    return 1;
}
