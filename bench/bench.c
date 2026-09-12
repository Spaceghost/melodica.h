#define _POSIX_C_SOURCE 200809L
#include "melodica.h"

#include <stdint.h>
#include <stdio.h>
#include <time.h>

static uint64_t ns_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

int main(void) {
    static const uint8_t sample[] =
        "{\"method\":\"station.getPlaylist\",\"userAuthToken\":\"tiny-token\"," 
        "\"stationToken\":\"1234567890\",\"includeTrackLength\":true}";
    char out[512];
    const size_t input_len = sizeof sample - 1;
    const unsigned iterations = 1000000u;

    volatile size_t sink = 0;
    uint64_t start = ns_now();
    for (unsigned i = 0; i < iterations; ++i) {
        sink += melodica_json_escape(out, sizeof out, sample, input_len);
    }
    uint64_t elapsed = ns_now() - start;

    double mib = ((double)input_len * (double)iterations) / (1024.0 * 1024.0);
    double seconds = (double)elapsed / 1000000000.0;

    printf("json_escape: %.2f MiB/s (%u iterations, sink=%zu)\n",
           mib / seconds, iterations, (size_t)sink);
    return 0;
}
