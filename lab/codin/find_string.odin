package find_string

is_ws :: proc "contextless" (ch: u8) -> bool {
    return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'
}

is_hex :: proc "contextless" (ch: u8) -> bool {
    return (ch >= '0' && ch <= '9') ||
           (ch >= 'a' && ch <= 'f') ||
           (ch >= 'A' && ch <= 'F')
}

boundary :: proc "contextless" (json: [^]u8, n, pos: int) -> bool {
    if pos >= n do return true
    ch := json[pos]
    return is_ws(ch) || ch == ',' || ch == ']' || ch == '}'
}

quote_is_escaped :: proc "contextless" (json: [^]u8, pos0: int) -> bool {
    if pos0 == 0 do return false
    pos := pos0
    count := 0
    for pos > 0 {
        pos -= 1
        if json[pos] != '\\' do break
        count += 1
    }
    return count & 1 != 0
}

skip_ws :: proc "contextless" (json: [^]u8, n, pos0: int) -> int {
    pos := pos0
    for pos < n && is_ws(json[pos]) do pos += 1
    return pos
}

parse_string :: proc "contextless" (json: [^]u8, n, pos0: int,
                                      out_off, out_len: ^uintptr) -> int {
    pos := skip_ws(json, n, pos0)
    if pos >= n || json[pos] != '"' do return 2
    pos += 1
    start := pos

    for pos < n {
        ch := json[pos]
        if ch == '\\' {
            pos += 1
            if pos >= n do return 2
            esc := json[pos]
            if esc == 'u' {
                if pos + 4 >= n || !is_hex(json[pos+1]) || !is_hex(json[pos+2]) ||
                   !is_hex(json[pos+3]) || !is_hex(json[pos+4]) {
                    return 2
                }
                pos += 5
                continue
            }
            if !(esc == '"' || esc == '\\' || esc == '/' || esc == 'b' ||
                 esc == 'f' || esc == 'n' || esc == 'r' || esc == 't') {
                return 2
            }
            pos += 1
            continue
        }
        if ch == '"' {
            if !boundary(json, n, pos + 1) do return 2
            out_off^ = uintptr(start)
            out_len^ = uintptr(pos - start)
            return 0
        }
        if ch < 0x20 do return 2
        pos += 1
    }
    return 2
}

lab_find_string :: proc "c" (json_raw: rawptr, json_len: uintptr,
                              key_raw: rawptr, key_len: uintptr,
                              out_off, out_len: ^uintptr) -> int {
    if json_raw == nil || key_raw == nil || out_off == nil || out_len == nil do return 4
    json := ([^]u8)(json_raw)
    key := ([^]u8)(key_raw)
    n := int(json_len)
    kn := int(key_len)
    if kn + 2 > n do return 1

    i := 0
    for i + kn + 2 <= n {
        if json[i] == '"' && !quote_is_escaped(json, i) {
            k := 0
            for k < kn && json[i+1+k] == key[k] do k += 1
            if k == kn && json[i+1+kn] == '"' {
                after := skip_ws(json, n, i + kn + 2)
                if after < n && json[after] == ':' {
                    return parse_string(json, n, after + 1, out_off, out_len)
                }
            }
        }
        i += 1
    }
    return 1
}
