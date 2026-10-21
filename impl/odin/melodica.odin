package main

MELODICA_ABI_VERSION :: u32(1)
station_prefix :: "{\"returnAllStations\":true,\"userAuthToken\":\""
station_suffix :: "\",\"syncTime\":"

is_unreserved :: #force_inline proc "contextless" (c: u8) -> bool {
	folded := c | 0x20
	return (folded >= 'a' && folded <= 'z') ||
	       (c >= '0' && c <= '9') ||
	       c == '-' || c == '.' || c == '_' || c == '~'
}

hex_digit :: #force_inline proc "contextless" (n: u8) -> u8 {
	digits := "0123456789ABCDEF"
	return digits[n]
}

json_escape_extra :: #force_inline proc "contextless" (c: u8) -> uintptr {
	if c >= 0x20 {
		if c == '"' || c == '\\' {
			return 1
		}
		return 0
	}
	switch c {
	case '\b', '\f', '\n', '\r', '\t':
		return 1
	case:
		return 5
	}
}

copy_bytes :: #force_inline proc "contextless" (dst: [^]u8, src: [^]u8, src_len: uintptr) {
	for i in 0..<src_len {
		dst[i] = src[i]
	}
}

url_encode_size_impl :: #force_inline proc "contextless" (src: [^]u8, src_len: uintptr) -> uintptr {
	required: uintptr = 0
	for i in 0..<src_len {
		if is_unreserved(src[i]) {
			required += 1
		} else {
			required += 3
		}
	}
	return required
}

write_url :: #force_inline proc "contextless" (dst: [^]u8, src: [^]u8, src_len: uintptr) -> uintptr {
	out: uintptr = 0
	for i in 0..<src_len {
		c := src[i]
		if is_unreserved(c) {
			dst[out] = c
			out += 1
		} else {
			dst[out + 0] = '%'
			dst[out + 1] = hex_digit(c >> 4)
			dst[out + 2] = hex_digit(c & 0x0f)
			out += 3
		}
	}
	return out
}

// Packed bytes avoid alignment assumptions and preserve all high UTF-8 bytes.
json_plain4 :: #force_inline proc "contextless" (src: [^]u8) -> bool {
	word := u32(src[0]) | (u32(src[1]) << 8) | (u32(src[2]) << 16) | (u32(src[3]) << 24)
	quotes := word ~ u32(0x22222222)
	slashes := word ~ u32(0x5c5c5c5c)
	controls := (word - 0x20202020) & ~word
	quote_zero := (quotes - 0x01010101) & ~quotes
	slash_zero := (slashes - 0x01010101) & ~slashes
	return ((controls | quote_zero | slash_zero) & 0x80808080) == 0
}

json_escape_size_impl :: #force_inline proc "contextless" (src: [^]u8, src_len: uintptr) -> uintptr {
	required := src_len
	i: uintptr = 0
	for src_len - i >= 4 && json_plain4(&src[i]) { i += 4 }
	for ; i < src_len; i += 1 {
		c := src[i]
		if c == '"' || c == '\\' {
			required += 1
		} else if c < 0x20 {
			required += json_escape_extra(c)
		}
	}
	return required
}

write_json :: #force_inline proc "contextless" (
	dst: [^]u8,
	out_in: uintptr,
	src: [^]u8,
	src_len: uintptr,
) -> uintptr {
	out := out_in
	for i in 0..<src_len {
		c := src[i]
		if c >= 0x20 {
			if c == '"' || c == '\\' {
				dst[out] = '\\'
				dst[out + 1] = c
				out += 2
			} else {
				dst[out] = c
				out += 1
			}
			continue
		}
		switch c {
		case '\b':
			dst[out + 0] = '\\'; dst[out + 1] = 'b'; out += 2
		case '\f':
			dst[out + 0] = '\\'; dst[out + 1] = 'f'; out += 2
		case '\n':
			dst[out + 0] = '\\'; dst[out + 1] = 'n'; out += 2
		case '\r':
			dst[out + 0] = '\\'; dst[out + 1] = 'r'; out += 2
		case '\t':
			dst[out + 0] = '\\'; dst[out + 1] = 't'; out += 2
		case:
			dst[out + 0] = '\\'; dst[out + 1] = 'u'
			dst[out + 2] = '0'; dst[out + 3] = '0'
			dst[out + 4] = hex_digit(c >> 4); dst[out + 5] = hex_digit(c & 0x0f)
			out += 6
		}
	}
	return out
}

decimal_size :: #force_inline proc "contextless" (value_in: uintptr) -> uintptr {
	value := value_in
	digits: uintptr = 1
	for value >= 10000 {
		value /= 10000
		digits += 4
	}
	if value >= 1000 { return digits + 3 }
	if value >= 100 { return digits + 2 }
	if value >= 10 { return digits + 1 }
	return digits
}

write_decimal :: #force_inline proc "contextless" (dst: [^]u8, out_in: uintptr, value_in: uintptr) -> uintptr {
	digits: [32]u8
	count: uintptr = 0
	value := value_in
	for value >= 100 {
		pair := value % 100
		value /= 100
		digits[count] = '0' + u8(pair % 10)
		digits[count + 1] = '0' + u8(pair / 10)
		count += 2
	}
	if value >= 10 {
		digits[count] = '0' + u8(value % 10)
		digits[count + 1] = '0' + u8(value / 10)
		count += 2
	} else {
		digits[count] = '0' + u8(value)
		count += 1
	}

	out := out_in
	for count != 0 {
		count -= 1
		dst[out] = digits[count]
		out += 1
	}
	return out
}

station_list_request_size_impl :: #force_inline proc "contextless" (
	user_auth_token: [^]u8,
	user_auth_token_len: uintptr,
	sync_time: uintptr,
) -> uintptr {
	return uintptr(len(station_prefix)) +
	       json_escape_size_impl(user_auth_token, user_auth_token_len) +
	       uintptr(len(station_suffix)) + decimal_size(sync_time) + 1
}

@(export)
melodica_abi_version :: proc "c" () -> u32 {
	return MELODICA_ABI_VERSION
}

@(export)
melodica_url_encode_size :: proc "c" (src: [^]u8, src_len: uintptr) -> uintptr {
	if src == nil {
		return 0
	}
	return url_encode_size_impl(src, src_len)
}

@(export)
melodica_url_encode :: proc "c" (
	dst: [^]u8,
	dst_cap: uintptr,
	src: [^]u8,
	src_len: uintptr,
) -> uintptr {
	if src == nil {
		return 0
	}
	if dst != nil && src_len <= dst_cap / 3 {
		return write_url(dst, src, src_len)
	}

	required := url_encode_size_impl(src, src_len)
	if dst == nil || dst_cap < required {
		return required
	}
	if required == src_len {
		copy_bytes(dst, src, src_len)
		return required
	}
	_ = write_url(dst, src, src_len)
	return required
}

@(export)
melodica_json_escape_size :: proc "c" (src: [^]u8, src_len: uintptr) -> uintptr {
	if src == nil {
		return 0
	}
	return json_escape_size_impl(src, src_len)
}

@(export)
melodica_json_escape :: proc "c" (
	dst: [^]u8,
	dst_cap: uintptr,
	src: [^]u8,
	src_len: uintptr,
) -> uintptr {
	if src == nil {
		return 0
	}
	if dst != nil && src_len <= dst_cap / 6 {
		return write_json(dst, 0, src, src_len)
	}

	required := json_escape_size_impl(src, src_len)
	if dst == nil || dst_cap < required {
		return required
	}
	if required == src_len {
		copy_bytes(dst, src, src_len)
		return required
	}
	_ = write_json(dst, 0, src, src_len)
	return required
}

@(export)
melodica_station_list_request_size :: proc "c" (
	user_auth_token: [^]u8,
	user_auth_token_len: uintptr,
	sync_time: uintptr,
) -> uintptr {
	if user_auth_token == nil {
		return 0
	}
	return station_list_request_size_impl(user_auth_token, user_auth_token_len, sync_time)
}

@(export)
melodica_station_list_request :: proc "c" (
	dst: [^]u8,
	dst_cap: uintptr,
	user_auth_token: [^]u8,
	user_auth_token_len: uintptr,
	sync_time: uintptr,
) -> uintptr {
	if user_auth_token == nil {
		return 0
	}
	auth_required := json_escape_size_impl(user_auth_token, user_auth_token_len)
	required := uintptr(len(station_prefix)) + auth_required +
	            uintptr(len(station_suffix)) + decimal_size(sync_time) + 1
	if dst == nil || dst_cap < required {
		return required
	}

	prefix := station_prefix
	suffix := station_suffix
	out: uintptr = 0
	for i in 0..<len(prefix) {
		dst[out] = prefix[i]
		out += 1
	}
	if auth_required == user_auth_token_len {
		copy_bytes(&dst[out], user_auth_token, user_auth_token_len)
		out += user_auth_token_len
	} else {
		out = write_json(dst, out, user_auth_token, user_auth_token_len)
	}
	for i in 0..<len(suffix) {
		dst[out] = suffix[i]
		out += 1
	}
	out = write_decimal(dst, out, sync_time)
	dst[out] = '}'
	return required
}
