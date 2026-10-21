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

json_plain4 :: proc "contextless" (src: []u8) -> bool {
	word := u32(src[0]) | (u32(src[1]) << 8) |
	        (u32(src[2]) << 16) | (u32(src[3]) << 24)
	quotes := word ~ u32(0x22222222)
	slashes := word ~ u32(0x5c5c5c5c)
	exceptional := (word - u32(0x20202020)) |
	               (quotes - u32(0x01010101)) | (slashes - u32(0x01010101))
	return (exceptional & (word ~ u32(0xffffffff)) & u32(0x80808080)) == 0
}

json_escape_size_impl :: proc "contextless" (src: [^]u8, src_len: uintptr) -> uintptr {
	required := src_len
	plain: uintptr = 0
	for group in 0..<src_len/4 {
		if !json_plain4(src[plain:plain + 4]) { break }
		plain += 4
	}
	for i in plain..<src_len {
		c := src[i]
		if c == '"' || c == '\\' {
			required += 1
		} else if c < 0x20 {
			required += json_escape_extra(c)
		}
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
		if c >= 0x20 {
			if c == '"' || c == '\\' {
				dst[out] = '\\'
				dst[out + 1] = c
				out += 2
			} else {
				dst[out] = c
				out += 1
			}
		} else {
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
	}
	return out
}

decimal_size :: proc "contextless" (value_in: uintptr) -> uintptr {
	value := value_in
	// A uintptr has at most 20 decimal digits on the supported C ABI targets.
	for group in 0..<6 {
		if value < 10000 {
			if value < 10 { return uintptr(group)*4 + 1 }
			if value < 100 { return uintptr(group)*4 + 2 }
			if value < 1000 { return uintptr(group)*4 + 3 }
			return uintptr(group)*4 + 4
		}
		value /= 10000
	}
	return 20
}

write_decimal :: proc "contextless" (dst: [^]u8, out_in: uintptr, value_in: uintptr) -> uintptr {
	digits := [32]u8{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	count: uintptr = 0
	value := value_in
	for pair_index in 0..<10 {
		if value < 100 { break }
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
	for i in 0..<count { dst[out_in + i] = digits[count - i - 1] }
	return out_in + count
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
	auth_required := json_escape_size_impl(user_auth_token, user_auth_token_len)
	required := 43 + auth_required + 13 + decimal_size(sync_time) + 1
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
	if auth_required == user_auth_token_len {
		for i in 0..<user_auth_token_len {
			dst[out + i] = user_auth_token[i]
		}
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
