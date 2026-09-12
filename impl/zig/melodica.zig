const ABI_VERSION: u32 = 1;

fn isUnreserved(c: u8) bool {
    return (c >= 'A' and c <= 'Z') or
        (c >= 'a' and c <= 'z') or
        (c >= '0' and c <= '9') or
        c == '-' or c == '.' or c == '_' or c == '~';
}

fn hexDigit(n: u8) u8 {
    return if (n < 10) '0' + n else 'A' + (n - 10);
}

fn jsonExtra(c: u8) usize {
    return switch (c) {
        '"', '\\', '\x08', '\x0c', '\n', '\r', '\t' => 1,
        else => if (c < 0x20) 5 else 0,
    };
}

export fn melodica_abi_version() u32 {
    return ABI_VERSION;
}

export fn melodica_url_encode_size(src_opt: ?[*]const u8, src_len: usize) usize {
    const src = src_opt orelse return 0;
    var required: usize = 0;
    var i: usize = 0;
    while (i < src_len) : (i += 1) {
        required += if (isUnreserved(src[i])) 1 else 3;
    }
    return required;
}

export fn melodica_url_encode(
    dst_opt: ?[*]u8,
    dst_cap: usize,
    src_opt: ?[*]const u8,
    src_len: usize,
) usize {
    const required = melodica_url_encode_size(src_opt, src_len);
    const src = src_opt orelse return required;
    if (dst_opt == null or dst_cap < required) return required;
    const dst = dst_opt.?;

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
    return required;
}

export fn melodica_json_escape_size(src_opt: ?[*]const u8, src_len: usize) usize {
    const src = src_opt orelse return 0;
    var required = src_len;
    var i: usize = 0;
    while (i < src_len) : (i += 1) required += jsonExtra(src[i]);
    return required;
}

export fn melodica_json_escape(
    dst_opt: ?[*]u8,
    dst_cap: usize,
    src_opt: ?[*]const u8,
    src_len: usize,
) usize {
    const required = melodica_json_escape_size(src_opt, src_len);
    const src = src_opt orelse return required;
    if (dst_opt == null or dst_cap < required) return required;
    const dst = dst_opt.?;

    var out: usize = 0;
    var i: usize = 0;
    while (i < src_len) : (i += 1) {
        const c = src[i];
        switch (c) {
            '"' => { dst[out] = '\\'; dst[out + 1] = '"'; out += 2; },
            '\\' => { dst[out] = '\\'; dst[out + 1] = '\\'; out += 2; },
            '\x08' => { dst[out] = '\\'; dst[out + 1] = 'b'; out += 2; },
            '\x0c' => { dst[out] = '\\'; dst[out + 1] = 'f'; out += 2; },
            '\n' => { dst[out] = '\\'; dst[out + 1] = 'n'; out += 2; },
            '\r' => { dst[out] = '\\'; dst[out + 1] = 'r'; out += 2; },
            '\t' => { dst[out] = '\\'; dst[out + 1] = 't'; out += 2; },
            else => {
                if (c < 0x20) {
                    dst[out] = '\\';
                    dst[out + 1] = 'u';
                    dst[out + 2] = '0';
                    dst[out + 3] = '0';
                    dst[out + 4] = hexDigit(c >> 4);
                    dst[out + 5] = hexDigit(c & 0x0f);
                    out += 6;
                } else {
                    dst[out] = c;
                    out += 1;
                }
            },
        }
    }
    return required;
}
