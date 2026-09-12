#include "melodica.h"

#include <stdio.h>
#include <string.h>

static int expect_bytes(
    const char *label,
    const char *actual,
    size_t actual_len,
    const char *expected,
    size_t expected_len
) {
    if (actual_len == expected_len && memcmp(actual, expected, expected_len) == 0) {
        return 0;
    }

    fprintf(stderr, "%s mismatch: got %zu bytes, expected %zu\n",
            label, actual_len, expected_len);
    return 1;
}

int main(void) {
    if (melodica_abi_version() != MELODICA_ABI_VERSION) {
        fprintf(stderr, "ABI version mismatch\n");
        return 1;
    }

    {
        static const uint8_t input[] = "A b/+~";
        static const char expected[] = "A%20b%2F%2B~";
        char output[sizeof expected - 1];

        size_t needed = melodica_url_encode_size(input, sizeof input - 1);
        if (needed != sizeof expected - 1) {
            fprintf(stderr, "url size mismatch\n");
            return 1;
        }
        if (melodica_url_encode(NULL, 0, input, sizeof input - 1) != needed) {
            fprintf(stderr, "url sizing call mismatch\n");
            return 1;
        }
        if (melodica_url_encode(output, needed - 1, input, sizeof input - 1) != needed) {
            fprintf(stderr, "url short-buffer call mismatch\n");
            return 1;
        }
        if (melodica_url_encode(output, sizeof output, input, sizeof input - 1) != needed) {
            fprintf(stderr, "url encode call mismatch\n");
            return 1;
        }
        if (expect_bytes("url", output, needed, expected, sizeof expected - 1)) {
            return 1;
        }
    }

    {
        static const uint8_t input[] = {'a', '"', 'b', '\n', 0x01};
        static const char expected[] = "a\\\"b\\n\\u0001";
        char output[sizeof expected - 1];

        size_t needed = melodica_json_escape_size(input, sizeof input);
        if (needed != sizeof expected - 1) {
            fprintf(stderr, "json size mismatch\n");
            return 1;
        }
        if (melodica_json_escape(output, sizeof output, input, sizeof input) != needed) {
            fprintf(stderr, "json escape call mismatch\n");
            return 1;
        }
        if (expect_bytes("json", output, needed, expected, sizeof expected - 1)) {
            return 1;
        }
    }

    puts("melodica smoke: ok");
    return 0;
}
