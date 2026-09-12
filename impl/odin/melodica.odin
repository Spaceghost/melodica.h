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

@(export)
melodica_abi_version :: proc "c" () -> u32 {
	return MELODICA_ABI_VERSION
}

@(export)
melodica_url_encode_size :: proc "c" (src: [^]u8, src_len: uintptr) -> uintptr {
	if src == nil {
		return 0
	}

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

@(export)
melodica_url_encode :: proc "c" (
	dst: [^]u8,
	dst_cap: uintptr,
	src: [^]u8,
	src_len: uintptr,
) -> uintptr {
	required := melodica_url_encode_size(src, src_len)
	if dst == nil || dst_cap < required || src == nil {
		return required
	}

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
	return required
}

json_escape_extra :: proc "contextless" (c: u8) -> uintptr {
	switch c {
	case '"', '\\', '\b', '\f', '\n', '\r', '\t':
		return 1
	case:
		if c < 0x20 {
			return 5
		}
	}
	return 0
}

@(export)
melodica_json_escape_size :: proc "c" (src: [^]u8, src_len: uintptr) -> uintptr {
	if src == nil {
		return 0
	}

	required := src_len
	for i in 0..<src_len {
		required += json_escape_extra(src[i])
	}
	return required
}

@(export)
melodica_json_escape :: proc "c" (
	dst: [^]u8,
	dst_cap: uintptr,
	src: [^]u8,
	src_len: uintptr,
) -> uintptr {
	required := melodica_json_escape_size(src, src_len)
	if dst == nil || dst_cap < required || src == nil {
		return required
	}

	out: uintptr = 0
	for i in 0..<src_len {
		c := src[i]
		switch c {
		case '"':
			dst[out + 0] = '\\'
			dst[out + 1] = '"'
			out += 2
		case '\\':
			dst[out + 0] = '\\'
			dst[out + 1] = '\\'
			out += 2
		case '\b':
			dst[out + 0] = '\\'
			dst[out + 1] = 'b'
			out += 2
		case '\f':
			dst[out + 0] = '\\'
			dst[out + 1] = 'f'
			out += 2
		case '\n':
			dst[out + 0] = '\\'
			dst[out + 1] = 'n'
			out += 2
		case '\r':
			dst[out + 0] = '\\'
			dst[out + 1] = 'r'
			out += 2
		case '\t':
			dst[out + 0] = '\\'
			dst[out + 1] = 't'
			out += 2
		case:
			if c < 0x20 {
				dst[out + 0] = '\\'
				dst[out + 1] = 'u'
				dst[out + 2] = '0'
				dst[out + 3] = '0'
				dst[out + 4] = hex_digit(c >> 4)
				dst[out + 5] = hex_digit(c & 0x0f)
				out += 6
			} else {
				dst[out] = c
				out += 1
			}
		}
	}
	return required
}
