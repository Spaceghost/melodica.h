#include "abi.h"

#include <stdio.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL %d: %s\n", __LINE__, #x); return 1; } } while (0)

static int eq(const char *json, size_t off, size_t len, const char *want) {
    return len == strlen(want) && memcmp(json + off, want, len) == 0;
}

int main(void) {
    size_t off = 0, len = 0;
    const char json[] =
        "{\"note\":\"escaped \\\"authToken\\\":\\\"trap\\\"\","
        "\"authToken\":\"real-token\",\"nested\":{\"x\":1}}";

    CHECK(lab_find_string(json, sizeof json - 1, "authToken", 9, &off, &len) == LAB_OK);
    CHECK(eq(json, off, len, "real-token"));
    CHECK(lab_find_string(json, sizeof json - 1, "missing", 7, &off, &len) == LAB_NOT_FOUND);

    {
        const char bad[] = "{\"x\":\"unterminated}";
        CHECK(lab_find_string(bad, sizeof bad - 1, "x", 1, &off, &len) == LAB_INVALID_JSON);
    }
    {
        const char bad[] = "{\"x\":\"bad\\q\"}";
        CHECK(lab_find_string(bad, sizeof bad - 1, "x", 1, &off, &len) == LAB_INVALID_JSON);
    }
    {
        const char bad[] = "{\"x\":\"bad\\u12xz\"}";
        CHECK(lab_find_string(bad, sizeof bad - 1, "x", 1, &off, &len) == LAB_INVALID_JSON);
    }
    {
        const char bad[] = "{\"x\":\"ok\"junk}";
        CHECK(lab_find_string(bad, sizeof bad - 1, "x", 1, &off, &len) == LAB_INVALID_JSON);
    }
    {
        const char good[] = "{\"x\":\"ok\\u263a\"}";
        CHECK(lab_find_string(good, sizeof good - 1, "x", 1, &off, &len) == LAB_OK);
        CHECK(eq(good, off, len, "ok\\u263a"));
    }
    CHECK(lab_find_string(NULL, 0, "x", 1, &off, &len) == LAB_BAD_ARGUMENT);
    puts("ok");
    return 0;
}
