#ifndef MELODICA_H_INCLUDED
#define MELODICA_H_INCLUDED

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MELODICA_ABI_VERSION 1u
#define MELODICA_VERSION_MAJOR 0u
#define MELODICA_VERSION_MINOR 1u
#define MELODICA_VERSION_PATCH 0u

/*
 * Shared ABI for every implementation lane.
 *
 * The encode functions are allocation-free and binary-safe. They return the
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

#ifdef MELODICA_IMPLEMENTATION

static int melodica__is_unreserved(const uint8_t c) {
    return (c >= (uint8_t)'A' && c <= (uint8_t)'Z') ||
           (c >= (uint8_t)'a' && c <= (uint8_t)'z') ||
           (c >= (uint8_t)'0' && c <= (uint8_t)'9') ||
           c == (uint8_t)'-' || c == (uint8_t)'.' ||
           c == (uint8_t)'_' || c == (uint8_t)'~';
}

static char melodica__hex(const uint8_t n) {
    return (char)(n < 10u ? '0' + (int)n : 'A' + (int)n - 10);
}

static size_t melodica__json_extra(const uint8_t c) {
    switch (c) {
        case (uint8_t)'"': case (uint8_t)'\\':
        case (uint8_t)'\b': case (uint8_t)'\f':
        case (uint8_t)'\n': case (uint8_t)'\r': case (uint8_t)'\t':
            return 1u;
        default:
            return c < 0x20u ? 5u : 0u;
    }
}

uint32_t melodica_abi_version(void) {
    return MELODICA_ABI_VERSION;
}

size_t melodica_url_encode_size(const uint8_t *src, const size_t src_len) {
    if (src == NULL) return 0u;
    size_t required = 0u;
    for (size_t i = 0u; i < src_len; ++i) {
        required += melodica__is_unreserved(src[i]) ? 1u : 3u;
    }
    return required;
}

size_t melodica_url_encode(char *dst, const size_t dst_cap,
        const uint8_t *src, const size_t src_len) {
    const size_t required = melodica_url_encode_size(src, src_len);
    if (dst == NULL || dst_cap < required || src == NULL) return required;

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
    if (src == NULL) return 0u;
    size_t required = src_len;
    for (size_t i = 0u; i < src_len; ++i) required += melodica__json_extra(src[i]);
    return required;
}

size_t melodica_json_escape(char *dst, const size_t dst_cap,
        const uint8_t *src, const size_t src_len) {
    const size_t required = melodica_json_escape_size(src, src_len);
    if (dst == NULL || dst_cap < required || src == NULL) return required;

    size_t out = 0u;
    for (size_t i = 0u; i < src_len; ++i) {
        const uint8_t c = src[i];
        switch (c) {
            case (uint8_t)'"': dst[out++] = '\\'; dst[out++] = '"'; break;
            case (uint8_t)'\\': dst[out++] = '\\'; dst[out++] = '\\'; break;
            case (uint8_t)'\b': dst[out++] = '\\'; dst[out++] = 'b'; break;
            case (uint8_t)'\f': dst[out++] = '\\'; dst[out++] = 'f'; break;
            case (uint8_t)'\n': dst[out++] = '\\'; dst[out++] = 'n'; break;
            case (uint8_t)'\r': dst[out++] = '\\'; dst[out++] = 'r'; break;
            case (uint8_t)'\t': dst[out++] = '\\'; dst[out++] = 't'; break;
            default:
                if (c < 0x20u) {
                    dst[out++] = '\\'; dst[out++] = 'u';
                    dst[out++] = '0'; dst[out++] = '0';
                    dst[out++] = melodica__hex((uint8_t)(c >> 4u));
                    dst[out++] = melodica__hex((uint8_t)(c & 0x0fu));
                } else {
                    dst[out++] = (char)c;
                }
                break;
        }
    }
    return required;
}

#endif /* MELODICA_IMPLEMENTATION */

#ifdef __cplusplus
}
#endif

#endif /* MELODICA_H_INCLUDED */
