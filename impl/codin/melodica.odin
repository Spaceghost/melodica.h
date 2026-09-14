package main

MELODICA_ABI_VERSION :: u32(1)

is_unreserved :: proc "contextless" (c: u8) -> bool {
	return (c >= 'A' && c <= 'Z') ||
	       (c >= 'a' && c <= 'z') ||
	       (c >= '0' && c <= '9') ||
	       c == '-' || c == '.' || c == '_' || c == '~'
}

hex_digit :: proc "contextless" (n: u8) -> u8 {
	if n < 10 {
		return '0' + n
	}
	return 'A' + (n - 10)
}

json_escape_extra :: proc "contextless" (c: u8) -> uintptr {
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

copy_bytes :: proc "contextless" (dst: [^]u8, src: [^]u8, src_len: uintptr) {
	for i in 0..<src_len {
		dst[i] = src[i]
	}
}

url_encode_size_impl :: proc "contextless" (src: [^]u8, src_len: uintptr) -> uintptr {
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

write_url :: proc "contextless" (dst: [^]u8, src: [^]u8, src_len: uintptr) -> uintptr {
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

json_escape_size_impl :: proc "contextless" (src: [^]u8, src_len: uintptr) -> uintptr {
	required := src_len
	for i in 0..<src_len {
		required += json_escape_extra(src[i])
	}
	return required
}

write_json :: proc "contextless" (
	dst: [^]u8,
	out_in: uintptr,
	src: [^]u8,
	src_len: uintptr,
) -> uintptr {
	out := out_in
	for i in 0..<src_len {
		c := src[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			dst[out] = c
			out += 1
		} else {
			switch c {
			case '"':
				dst[out + 0] = '\\'; dst[out + 1] = '"'; out += 2
			case '\\':
				dst[out + 0] = '\\'; dst[out + 1] = '\\'; out += 2
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
	}
	return out
}

decimal_size :: proc "contextless" (value: uintptr) -> uintptr {
	if value < 10 {
		return 1
	}
	return 1 + decimal_size(value / 10)
}

write_decimal :: proc "contextless" (dst: [^]u8, out_in: uintptr, value: uintptr) -> uintptr {
	out := out_in
	if value >= 10 {
		out = write_decimal(dst, out, value / 10)
	}
	dst[out] = '0' + u8(value % 10)
	return out + 1
}

station_list_request_size_impl :: proc "contextless" (
	user_auth_token: [^]u8,
	user_auth_token_len: uintptr,
	sync_time: uintptr,
) -> uintptr {
	return 43 + json_escape_size_impl(user_auth_token, user_auth_token_len) +
	       13 + decimal_size(sync_time) + 1
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
	required := station_list_request_size_impl(user_auth_token, user_auth_token_len, sync_time)
	if dst == nil || dst_cap < required {
		return required
	}

	prefix := "{\"returnAllStations\":true,\"userAuthToken\":\""
	suffix := "\",\"syncTime\":"
	out: uintptr = 0
	for i in 0..<len(prefix) {
		dst[out] = prefix[i]
		out += 1
	}
	out = write_json(dst, out, user_auth_token, user_auth_token_len)
	for i in 0..<len(suffix) {
		dst[out] = suffix[i]
		out += 1
	}
	out = write_decimal(dst, out, sync_time)
	dst[out] = '}'
	return required
}
