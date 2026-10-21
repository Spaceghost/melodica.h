/* Benchmark the exact differential suites, including setup and ownership cleanup.
 * Each suite is compiled separately with its main/time/report symbols renamed.
 * Reporting calls remain in the measured work but perform no formatting or I/O.
 * Assertions stay enabled. This measures suites/s, never individual requests/s.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int api_piano(void);
int api_playlist(int, char **);
int api_search(void);
int api_station_mutations(void);
int api_feedback(void);
int api_seed(void);
int api_station_info(void);
int api_quickmix_genre(void);
int api_explain_bookmarks(void);
int api_settings(void);
int api_station_modes(void);

int api_quiet_printf(const char *format, ...) { (void)format; return 0; }
int api_quiet_puts(const char *text) { (void)text; return 0; }
int api_quiet_fputs(const char *text, FILE *stream) {
    (void)text; (void)stream; return 0;
}
int api_quiet_putchar(int value) { return value; }

/* The linked libraries must see exactly the same fixed clock as the probes. */
time_t time(time_t *out) {
    const time_t now = (time_t)1700000000;
    if (out != NULL) *out = now;
    return now;
}

static uint64_t ns_now(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) abort();
    return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

static uint64_t median(uint64_t values[5]) {
    for (unsigned i = 1; i < 5u; ++i) {
        const uint64_t value = values[i];
        unsigned j = i;
        while (j != 0u && values[j - 1u] > value) {
            values[j] = values[j - 1u];
            --j;
        }
        values[j] = value;
    }
    return values[2];
}

static int playlist_suite(void) {
    char name[] = "api-playlist";
    char *argv[] = {name, NULL};
    return api_playlist(1, argv);
}

int main(void) {
    static const struct { const char *name; int (*run)(void); } suites[] = {
        {"piano", api_piano}, {"playlist", playlist_suite},
        {"search", api_search}, {"station_mutations", api_station_mutations},
        {"feedback", api_feedback}, {"seed", api_seed},
        {"station_info", api_station_info}, {"quickmix_genre", api_quickmix_genre},
        {"explain_bookmarks", api_explain_bookmarks}, {"settings", api_settings},
        {"station_modes", api_station_modes}
    };
    const unsigned iterations = 100u;
    for (size_t suite = 0; suite < sizeof(suites) / sizeof(suites[0]); ++suite) {
        uint64_t samples[5];
        for (unsigned round = 0; round < 6u; ++round) {
            const uint64_t start = ns_now();
            for (unsigned i = 0; i < iterations; ++i) {
                if (suites[suite].run() != 0) {
                    fprintf(stderr, "API suite failed: %s\n", suites[suite].name);
                    return 1;
                }
            }
            if (round != 0u) samples[round - 1u] = ns_now() - start;
        }
        printf("%s %.3f suites/s median_of=5 iterations=%u\n", suites[suite].name,
            (double)iterations * 1e9 / (double)median(samples), iterations);
    }
    return 0;
}
