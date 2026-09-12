#ifndef MELODICA_H_INCLUDED
#define MELODICA_H_INCLUDED

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MELODICA_ABI_VERSION 1u

/*
 * Shared ABI for every implementation lane.
 *
 * The encode functions are allocation-free and binary-safe. They return the
 * number of bytes required, excluding a NUL terminator. If dst is NULL or
 * dst_cap is smaller than the required size, they perform no writes.
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

#ifdef __cplusplus
}
#endif

#endif /* MELODICA_H_INCLUDED */
