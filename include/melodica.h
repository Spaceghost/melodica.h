#ifndef MELODICA_H_INCLUDED
#define MELODICA_H_INCLUDED

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MELODICA_ABI_VERSION 1u
#define MELODICA_VERSION_MAJOR 1u
#define MELODICA_VERSION_MINOR 0u
#define MELODICA_VERSION_PATCH 0u

/*
 * Shared ABI for every implementation lane.
 *
 * All serializers are allocation-free and binary-safe. They return the
 * number of bytes required, excluding a NUL terminator. If dst is NULL or
 * dst_cap is smaller than the required size, they perform no writes.
 *
 * Define MELODICA_IMPLEMENTATION in exactly one C/C++ translation unit to get
 * the portable C implementation directly from this header.
 */
uint32_t melodica_abi_version(void);

size_t melodica_url_encode_size(const uint8_t *src, size_t src_len);
size_t melodica_url_encode(
    char *dst,
    size_t dst_cap,
    const uint8_t *src,
    size_t src_len
);

size_t melodica_json_escape_size(const uint8_t *src, size_t src_len);
size_t melodica_json_escape(
    char *dst,
    size_t dst_cap,
    const uint8_t *src,
    size_t src_len
);

size_t melodica_station_list_request_size(
    const uint8_t *user_auth_token,
    size_t user_auth_token_len,
    uintptr_t sync_time
);
size_t melodica_station_list_request(
    char *dst,
    size_t dst_cap,
    const uint8_t *user_auth_token,
    size_t user_auth_token_len,
    uintptr_t sync_time
);

#ifdef MELODICA_IMPLEMENTATION

static const char melodica__station_prefix[] =
    "{\"returnAllStations\":true,\"userAuthToken\":\"";
static const char melodica__station_suffix[] = "\",\"syncTime\":";

static inline int melodica__is_unreserved(const uint8_t c) {
    return (c >= (uint8_t)'A' && c <= (uint8_t)'Z') ||
           (c >= (uint8_t)'a' && c <= (uint8_t)'z') ||
           (c >= (uint8_t)'0' && c <= (uint8_t)'9') ||
           c == (uint8_t)'-' || c == (uint8_t)'.' ||
           c == (uint8_t)'_' || c == (uint8_t)'~';
}

static inline char melodica__hex(const uint8_t n) {
    return (char)(n < 10u ? '0' + (int)n : 'A' + (int)n - 10);
}

static inline size_t melodica__json_extra(const uint8_t c) {
    if (c >= 0x20u) {
        return (c == (uint8_t)'"' || c == (uint8_t)'\\') ? 1u : 0u;
    }
    switch (c) {
        case (uint8_t)'\b': case (uint8_t)'\f':
        case (uint8_t)'\n': case (uint8_t)'\r': case (uint8_t)'\t':
            return 1u;
        default:
            return 5u;
    }
}

static inline void melodica__copy_bytes(
        char *dst, const uint8_t *src, const size_t src_len) {
    for (size_t i = 0u; i < src_len; ++i) dst[i] = (char)src[i];
}

static inline size_t melodica__url_encode_size(
        const uint8_t *src, const size_t src_len) {
    if (src == NULL) return 0u;
    size_t required = 0u;
    for (size_t i = 0u; i < src_len; ++i) {
        required += melodica__is_unreserved(src[i]) ? 1u : 3u;
    }
    return required;
}

/* Detect exceptional bytes four at a time without alignment assumptions.
 * The subtraction masks identify a control byte, quote or backslash. */
static inline int melodica__json_plain4(const uint8_t *src) {
    const uint32_t word = (uint32_t)src[0] | ((uint32_t)src[1] << 8u) |
        ((uint32_t)src[2] << 16u) | ((uint32_t)src[3] << 24u);
    const uint32_t quotes = word ^ UINT32_C(0x22222222);
    const uint32_t slashes = word ^ UINT32_C(0x5c5c5c5c);
    const uint32_t exceptional = (word - UINT32_C(0x20202020)) |
        (quotes - UINT32_C(0x01010101)) | (slashes - UINT32_C(0x01010101));
    return (exceptional & ~word & UINT32_C(0x80808080)) == 0u;
}

static inline size_t melodica__json_escape_size(
        const uint8_t *src, const size_t src_len) {
    if (src == NULL) return 0u;
    size_t required = src_len;
    size_t i = 0u;
    while (src_len - i >= 4u && melodica__json_plain4(src + i)) i += 4u;
    for (; i < src_len; ++i) {
        const uint8_t c = src[i];
        if (c == (uint8_t)'"' || c == (uint8_t)'\\') ++required;
        else if (c < 0x20u) required += melodica__json_extra(c);
    }
    return required;
}

static size_t melodica__write_json(
        char *dst, const size_t out_in, const uint8_t *src, const size_t src_len) {
    size_t out = out_in;
    for (size_t i = 0u; i < src_len; ++i) {
        const uint8_t c = src[i];
        if (c >= 0x20u) {
            if (c == (uint8_t)'"' || c == (uint8_t)'\\') {
                dst[out] = '\\';
                dst[out + 1u] = (char)c;
                out += 2u;
            } else {
                dst[out] = (char)c;
                out += 1u;
            }
        } else {
            switch (c) {
                case (uint8_t)'\b':
                    dst[out] = '\\'; dst[out + 1u] = 'b'; out += 2u; break;
                case (uint8_t)'\f':
                    dst[out] = '\\'; dst[out + 1u] = 'f'; out += 2u; break;
                case (uint8_t)'\n':
                    dst[out] = '\\'; dst[out + 1u] = 'n'; out += 2u; break;
                case (uint8_t)'\r':
                    dst[out] = '\\'; dst[out + 1u] = 'r'; out += 2u; break;
                case (uint8_t)'\t':
                    dst[out] = '\\'; dst[out + 1u] = 't'; out += 2u; break;
                default:
                    dst[out] = '\\'; dst[out + 1u] = 'u';
                    dst[out + 2u] = '0'; dst[out + 3u] = '0';
                    dst[out + 4u] = melodica__hex((uint8_t)(c >> 4u));
                    dst[out + 5u] = melodica__hex((uint8_t)(c & 0x0fu));
                    out += 6u;
                    break;
            }
        }
    }
    return out;
}

static inline size_t melodica__decimal_size(uintptr_t value) {
    size_t digits = 1u;
    while (value >= 10000u) {
        value /= 10000u;
        digits += 4u;
    }
    if (value >= 1000u) return digits + 3u;
    if (value >= 100u) return digits + 2u;
    if (value >= 10u) return digits + 1u;
    return digits;
}

static inline size_t melodica__write_decimal(
        char *dst, size_t out, uintptr_t value) {
    char digits[3u * sizeof(uintptr_t)];
    size_t count = 0u;
    while (value >= 100u) {
        const uintptr_t pair = value % 100u;
        value /= 100u;
        digits[count++] = (char)('0' + (int)(pair % 10u));
        digits[count++] = (char)('0' + (int)(pair / 10u));
    }
    if (value >= 10u) {
        digits[count++] = (char)('0' + (int)(value % 10u));
        digits[count++] = (char)('0' + (int)(value / 10u));
    } else {
        digits[count++] = (char)('0' + (int)value);
    }
    while (count != 0u) dst[out++] = digits[--count];
    return out;
}

static inline size_t melodica__station_list_request_size(
        const uint8_t *user_auth_token, const size_t user_auth_token_len,
        const uintptr_t sync_time) {
    if (user_auth_token == NULL) return 0u;
    return (sizeof(melodica__station_prefix) - 1u) +
        melodica__json_escape_size(user_auth_token, user_auth_token_len) +
        (sizeof(melodica__station_suffix) - 1u) +
        melodica__decimal_size(sync_time) + 1u;
}

uint32_t melodica_abi_version(void) {
    return MELODICA_ABI_VERSION;
}

size_t melodica_url_encode_size(const uint8_t *src, const size_t src_len) {
    return melodica__url_encode_size(src, src_len);
}

size_t melodica_url_encode(char *dst, const size_t dst_cap,
        const uint8_t *src, const size_t src_len) {
    if (src == NULL) return 0u;

    if (dst != NULL && src_len <= dst_cap / 3u) {
        size_t out = 0u;
        for (size_t i = 0u; i < src_len; ++i) {
            const uint8_t c = src[i];
            if (melodica__is_unreserved(c)) {
                dst[out++] = (char)c;
            } else {
                dst[out++] = '%';
                dst[out++] = melodica__hex((uint8_t)(c >> 4u));
                dst[out++] = melodica__hex((uint8_t)(c & 0x0fu));
            }
        }
        return out;
    }

    const size_t required = melodica__url_encode_size(src, src_len);
    if (dst == NULL || dst_cap < required) return required;
    if (required == src_len) {
        melodica__copy_bytes(dst, src, src_len);
        return required;
    }

    size_t out = 0u;
    for (size_t i = 0u; i < src_len; ++i) {
        const uint8_t c = src[i];
        if (melodica__is_unreserved(c)) {
            dst[out++] = (char)c;
        } else {
            dst[out++] = '%';
            dst[out++] = melodica__hex((uint8_t)(c >> 4u));
            dst[out++] = melodica__hex((uint8_t)(c & 0x0fu));
        }
    }
    return required;
}

size_t melodica_json_escape_size(const uint8_t *src, const size_t src_len) {
    return melodica__json_escape_size(src, src_len);
}

size_t melodica_json_escape(char *dst, const size_t dst_cap,
        const uint8_t *src, const size_t src_len) {
    if (src == NULL) return 0u;

    if (dst != NULL && src_len <= dst_cap / 6u) {
        return melodica__write_json(dst, 0u, src, src_len);
    }

    const size_t required = melodica__json_escape_size(src, src_len);
    if (dst == NULL || dst_cap < required) return required;
    if (required == src_len) {
        melodica__copy_bytes(dst, src, src_len);
        return required;
    }
    (void)melodica__write_json(dst, 0u, src, src_len);
    return required;
}

size_t melodica_station_list_request_size(const uint8_t *user_auth_token,
        const size_t user_auth_token_len, const uintptr_t sync_time) {
    return melodica__station_list_request_size(
        user_auth_token, user_auth_token_len, sync_time);
}

size_t melodica_station_list_request(char *dst, const size_t dst_cap,
        const uint8_t *user_auth_token, const size_t user_auth_token_len,
        const uintptr_t sync_time) {
    if (user_auth_token == NULL) return 0u;
    const size_t auth_required = melodica__json_escape_size(
        user_auth_token, user_auth_token_len);
    const size_t required = (sizeof(melodica__station_prefix) - 1u) +
        auth_required + (sizeof(melodica__station_suffix) - 1u) +
        melodica__decimal_size(sync_time) + 1u;
    if (dst == NULL || dst_cap < required) return required;

    size_t out = 0u;
    for (size_t i = 0u; i < sizeof(melodica__station_prefix) - 1u; ++i) {
        dst[out++] = melodica__station_prefix[i];
    }
    if (auth_required == user_auth_token_len) {
        melodica__copy_bytes(dst + out, user_auth_token, user_auth_token_len);
        out += user_auth_token_len;
    } else {
        out = melodica__write_json(dst, out, user_auth_token, user_auth_token_len);
    }
    for (size_t i = 0u; i < sizeof(melodica__station_suffix) - 1u; ++i) {
        dst[out++] = melodica__station_suffix[i];
    }
    out = melodica__write_decimal(dst, out, sync_time);
    dst[out] = '}';
    return required;
}

#endif /* MELODICA_IMPLEMENTATION */

#ifdef __cplusplus
}
#endif

#endif /* MELODICA_H_INCLUDED */
