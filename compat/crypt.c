#include "crypt.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int hex_value(const char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
}

char *melodica_piano_encrypt_string(const MelodicaBlowfish *ctx, const char *input) {
    static const char hex[] = "0123456789abcdef";
    if (ctx == NULL || input == NULL) return NULL;

    const size_t input_len = strlen(input);
    const size_t padded_len = input_len % 8u == 0u
        ? input_len : input_len + (8u - input_len % 8u);

    uint8_t *padded = (uint8_t *)calloc(padded_len + 1u, 1u);
    if (padded == NULL) return NULL;
    if (input_len != 0u) memcpy(padded, input, input_len);

    for (size_t i = 0u; i < padded_len; i += 8u) {
        melodica_blowfish_encrypt_block(ctx, padded + i);
    }

    char *output = (char *)malloc(padded_len * 2u + 1u);
    if (output == NULL) {
        free(padded);
        return NULL;
    }
    for (size_t i = 0u; i < padded_len; ++i) {
        output[i * 2u] = hex[padded[i] >> 4u];
        output[i * 2u + 1u] = hex[padded[i] & 0x0fu];
    }
    output[padded_len * 2u] = '\0';
    free(padded);
    return output;
}

char *melodica_piano_decrypt_string(const MelodicaBlowfish *ctx, const char *input,
        size_t *output_size) {
    if (ctx == NULL || input == NULL || output_size == NULL) return NULL;
    const size_t input_len = strlen(input);
    if (input_len % 16u != 0u) return NULL;

    const size_t decoded_len = input_len / 2u;
    uint8_t *output = (uint8_t *)calloc(decoded_len + 1u, 1u);
    if (output == NULL) return NULL;

    for (size_t i = 0u; i < decoded_len; ++i) {
        const int hi = hex_value(input[i * 2u]);
        const int lo = hex_value(input[i * 2u + 1u]);
        if (hi < 0 || lo < 0) {
            free(output);
            return NULL;
        }
        output[i] = (uint8_t)((unsigned)hi << 4u) | (uint8_t)lo;
    }

    for (size_t i = 0u; i < decoded_len; i += 8u) {
        melodica_blowfish_decrypt_block(ctx, output + i);
    }
    *output_size = decoded_len;
    return (char *)output;
}
