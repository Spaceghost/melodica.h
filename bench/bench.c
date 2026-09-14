#define _POSIX_C_SOURCE 200809L
#include "melodica.h"

#include <stdint.h>
#include <stdio.h>
#include <time.h>

#define BENCH_ROUNDS 5u
#define BENCH_TARGET_BYTES (48u * 1024u * 1024u)
#define STATION_ITERATIONS 750000u

typedef size_t (*transform_fn)(char *, size_t, const uint8_t *, size_t);

static volatile size_t bench_sink;

static uint64_t ns_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static uint64_t median_ns(uint64_t values[BENCH_ROUNDS]) {
    for (unsigned i = 1; i < BENCH_ROUNDS; ++i) {
        uint64_t value = values[i];
        unsigned j = i;
        while (j > 0 && values[j - 1] > value) {
            values[j] = values[j - 1];
            --j;
        }
        values[j] = value;
    }
    return values[BENCH_ROUNDS / 2u];
}

static unsigned iterations_for(size_t input_len) {
    size_t iterations = BENCH_TARGET_BYTES / input_len;
    if (iterations < 100000u) iterations = 100000u;
    if (iterations > 4000000u) iterations = 4000000u;
    return (unsigned)iterations;
}

static void bench_transform(
    const char *label,
    transform_fn fn,
    const uint8_t *input,
    size_t input_len,
    size_t output_cap
) {
    char output[2048];
    uint64_t samples[BENCH_ROUNDS];
    const unsigned iterations = iterations_for(input_len);

    for (unsigned i = 0; i < 4096u; ++i) {
        bench_sink += fn(output, output_cap, input, input_len);
    }

    for (unsigned round = 0; round < BENCH_ROUNDS; ++round) {
        uint64_t start = ns_now();
        for (unsigned i = 0; i < iterations; ++i) {
            bench_sink += fn(output, output_cap, input, input_len);
        }
        samples[round] = ns_now() - start;
    }

    const uint64_t elapsed = median_ns(samples);
    const double mib = ((double)input_len * (double)iterations) / (1024.0 * 1024.0);
    const double seconds = (double)elapsed / 1000000000.0;
    printf("%-22s %10.2f MiB/s  (%u iterations, median of %u)\n",
           label, mib / seconds, iterations, BENCH_ROUNDS);
}

static void bench_station_request(void) {
    static const uint8_t auth[] = "token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    char output[256];
    uint64_t samples[BENCH_ROUNDS];

    for (unsigned i = 0; i < 4096u; ++i) {
        bench_sink += melodica_station_list_request(
            output, sizeof output, auth, sizeof auth - 1u, (uintptr_t)1723456789u);
    }

    for (unsigned round = 0; round < BENCH_ROUNDS; ++round) {
        uint64_t start = ns_now();
        for (unsigned i = 0; i < STATION_ITERATIONS; ++i) {
            bench_sink += melodica_station_list_request(
                output, sizeof output, auth, sizeof auth - 1u,
                (uintptr_t)(1723456789u + (i & 1023u)));
        }
        samples[round] = ns_now() - start;
    }

    const uint64_t elapsed = median_ns(samples);
    const double seconds = (double)elapsed / 1000000000.0;
    printf("%-22s %10.2f Mreq/s (%u iterations, median of %u)\n",
           "station_request", ((double)STATION_ITERATIONS / seconds) / 1000000.0,
           STATION_ITERATIONS, BENCH_ROUNDS);
}

int main(void) {
    static const uint8_t json_ascii[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    static const uint8_t json_payload[] =
        "{\"method\":\"station.getPlaylist\",\"userAuthToken\":\"tiny-token\","
        "\"stationToken\":\"1234567890\",\"includeTrackLength\":true}";
    static const uint8_t url_ascii[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    static const uint8_t url_mixed[] =
        "station name/with spaces+slashes?and=query&more=%25#fragment:[]{}";

    puts("melodica language shootout (higher is better)");
    bench_transform("json_ascii", melodica_json_escape,
                    json_ascii, sizeof json_ascii - 1u, 512u);
    bench_transform("json_payload", melodica_json_escape,
                    json_payload, sizeof json_payload - 1u, 512u);
    bench_transform("url_ascii", melodica_url_encode,
                    url_ascii, sizeof url_ascii - 1u, 512u);
    bench_transform("url_mixed", melodica_url_encode,
                    url_mixed, sizeof url_mixed - 1u, 512u);
    bench_station_request();
    printf("sink=%zu\n", (size_t)bench_sink);
    return 0;
}
