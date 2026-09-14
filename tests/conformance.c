/* Shared, deterministic C-ABI conformance test. No implementation is embedded. */
#include "melodica.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_INPUT 1024u
#define MAX_OUTPUT (6u * MAX_INPUT + 128u)
#define GUARD 17u
static size_t case_id, checks;
static uint32_t rng = UINT32_C(0x51A7C0DE);

static void check(int ok, const char *what, unsigned kind, size_t n, size_t cap) {
    ++checks;
    if (!ok) {
        fprintf(stderr, "case=%zu kind=%u length=%zu capacity=%zu: %s\n",
                case_id, kind, n, cap, what);
        exit(1);
    }
}
static uint32_t next_random(void) {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return rng;
}
static size_t invoke(unsigned kind, char *dst, size_t cap,
        const uint8_t *src, size_t n, uintptr_t timestamp) {
    if (kind == 0u) return melodica_url_encode(dst, cap, src, n);
    if (kind == 1u) return melodica_json_escape(dst, cap, src, n);
    return melodica_station_list_request(dst, cap, src, n, timestamp);
}
static size_t size_call(unsigned kind, const uint8_t *src, size_t n, uintptr_t t) {
    if (kind == 0u) return melodica_url_encode_size(src, n);
    if (kind == 1u) return melodica_json_escape_size(src, n);
    return melodica_station_list_request_size(src, n, t);
}
/* Independent, intentionally simple oracle; decimal formatting uses libc. */
static size_t reference(unsigned kind, char *out, const uint8_t *src,
        size_t n, uintptr_t timestamp) {
    static const char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    static const char hex[] = "0123456789ABCDEF";
    size_t pos = 0u;
    if (kind == 2u) {
        const char *prefix = "{\"returnAllStations\":true,\"userAuthToken\":\"";
        pos = strlen(prefix); memcpy(out, prefix, pos);
    }
    for (size_t i = 0; i < n; ++i) {
        unsigned c = src[i];
        if (kind == 0u) {
            if (c != 0u && strchr(alphabet, (int)c) != NULL) out[pos++] = (char)c;
            else { out[pos++] = '%'; out[pos++] = hex[c / 16u]; out[pos++] = hex[c % 16u]; }
        } else {
            const char *escape = NULL;
            switch (c) {
                case '"': escape = "\\\""; break;
                case '\\': escape = "\\\\"; break;
                case '\b': escape = "\\b"; break;
                case '\f': escape = "\\f"; break;
                case '\n': escape = "\\n"; break;
                case '\r': escape = "\\r"; break;
                case '\t': escape = "\\t"; break;
                default: break;
            }
            if (escape != NULL) { memcpy(out + pos, escape, 2u); pos += 2u; }
            else if (c < 32u) {
                memcpy(out + pos, "\\u00", 4u); pos += 4u;
                out[pos++] = hex[c / 16u]; out[pos++] = hex[c % 16u];
            } else out[pos++] = (char)c;
        }
    }
    if (kind == 2u) {
        char suffix[96];
        int count = snprintf(suffix, sizeof(suffix), "\",\"syncTime\":%" PRIuPTR "}", timestamp);
        check(count > 0 && (size_t)count < sizeof(suffix), "oracle decimal", kind, n, 0);
        memcpy(out + pos, suffix, (size_t)count); pos += (size_t)count;
    }
    return pos;
}
static void one_case(const uint8_t *src, size_t n, uintptr_t timestamp) {
    char expected[MAX_OUTPUT];
    uint8_t original[MAX_INPUT];
    memcpy(original, src, n);
    ++case_id;
    for (unsigned kind = 0; kind < 3u; ++kind) {
        const size_t needed = reference(kind, expected, src, n, timestamp);
        size_t capacities[] = {0u, 1u, needed == 0u ? 0u : needed - 1u,
                              needed, needed + 1u, 6u * n + 96u};
        check(size_call(kind, src, n, timestamp) == needed, "size", kind, n, 0);
        check(invoke(kind, NULL, MAX_OUTPUT, src, n, timestamp) == needed,
              "null destination", kind, n, MAX_OUTPUT);
        for (size_t k = 0; k < sizeof(capacities) / sizeof(capacities[0]); ++k) {
            unsigned char storage[MAX_OUTPUT + 2u * GUARD];
            const size_t cap = capacities[k];
            memset(storage, 0xA5, sizeof(storage));
            size_t actual = invoke(kind, (char *)storage + GUARD, cap, src, n, timestamp);
            check(actual == needed, "return length", kind, n, cap);
            size_t written = cap < needed ? 0u : needed;
            check(written == 0u || memcmp(storage + GUARD, expected, written) == 0,
                  "output bytes", kind, n, cap);
            int untouched = 1;
            for (size_t j = 0; j < GUARD; ++j) if (storage[j] != 0xA5) untouched = 0;
            for (size_t j = GUARD + written; j < sizeof(storage); ++j)
                if (storage[j] != 0xA5) untouched = 0;
            check(untouched, "short-buffer write / guard / terminator", kind, n, cap);
            check(memcmp(original, src, n) == 0, "source mutation", kind, n, cap);
        }
    }
}
int main(void) {
    uint8_t input[MAX_INPUT + 1u];
    check(melodica_abi_version() == MELODICA_ABI_VERSION, "ABI", 0, 0, 0);
    memset(input, 0, sizeof(input));
    one_case(input + 1, 0, 0);
    for (unsigned b = 0; b < 256u; ++b) {
        input[1] = (uint8_t)b;
        one_case(input + 1, 1u, UINTPTR_MAX);
    }
    for (unsigned b = 0; b < 256u; ++b) input[b + 1] = (uint8_t)b;
    one_case(input + 1, 256u, UINTPTR_MAX);
    static const char clean[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    for (size_t n = 0; n <= MAX_INPUT; ++n) {
        input[n == MAX_INPUT ? n : n + 1] = (uint8_t)clean[n % (sizeof(clean) - 1u)];
        if (n < 34u || n == 63u || n == 64u || n == 65u || n == 127u || n == 128u ||
                n == 129u || n == 255u || n == 256u || n == 257u || n == 511u ||
                n == 512u || n == 513u || n == MAX_INPUT) one_case(input + 1, n, 0);
    }
    uintptr_t power = 1u;
    for (;;) {
        for (unsigned d = 0; d < 3u; ++d) one_case(input + 1, 33u, power - 1u + d);
        if (power > UINTPTR_MAX / 10u) break;
        power *= 10u;
    }
    for (unsigned trial = 0; trial < 1024u; ++trial) {
        size_t n = next_random() % (MAX_INPUT + 1u);
        for (size_t i = 0; i < n; ++i) input[i + 1u] = (uint8_t)next_random();
        uintptr_t t = (uintptr_t)next_random();
        if (sizeof(uintptr_t) > 4u) t = (t << 16u) ^ next_random();
        one_case(input + 1, n, t);
    }
    for (unsigned kind = 0; kind < 3u; ++kind) {
        unsigned char storage[32];
        memset(storage, 0xA5, sizeof(storage));
        check(size_call(kind, NULL, SIZE_MAX, UINTPTR_MAX) == 0, "null source size", kind, 0, 0);
        check(invoke(kind, (char *)storage, sizeof(storage), NULL, SIZE_MAX, UINTPTR_MAX) == 0,
              "null source", kind, 0, sizeof(storage));
        for (size_t j = 0; j < sizeof(storage); ++j)
            check(storage[j] == 0xA5, "null source write", kind, 0, sizeof(storage));
    }
    printf("conformance: %zu cases, %zu checks; all bytes, guards, short buffers, decimal boundaries: ok\n",
           case_id, checks);
    return 0;
}
