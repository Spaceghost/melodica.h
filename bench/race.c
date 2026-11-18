/* Shared before/after race driver. The canonical playlist fixture, clock,
 * warmup and five-round median are unchanged. Scaled search adds a second
 * list-building workload; it is reported separately from canonical suites. */
#define main canonical_playlist_main
#include "../tests/reference/playlist_probe.c"
#undef main

static void bench_search(PianoHandle_t *ph, size_t entries, unsigned iterations) {
    static const char artist[] = "{\"artistName\":\"Race artist\",\"musicToken\":\"artist-token\"}";
    static const char song[] = "{\"songName\":\"Race song\",\"artistName\":\"Race artist\",\"musicToken\":\"song-token\"}";
    const size_t capacity = 128u + entries * (sizeof(artist) + sizeof(song) + 2u);
    char *json = malloc(capacity), *out = json;
    assert(json != NULL);
    out += sprintf(out, "{\"stat\":\"ok\",\"result\":{\"artists\":[");
    for (size_t i = 0; i < entries; ++i) out += sprintf(out, "%s%s", i ? "," : "", artist);
    out += sprintf(out, "],\"songs\":[");
    for (size_t i = 0; i < entries; ++i) out += sprintf(out, "%s%s", i ? "," : "", song);
    out += sprintf(out, "]}}");
    assert((size_t)(out - json) < capacity);
    PianoRequestDataSearch_t data = {0};
    PianoRequest_t request = {0};
    request.type = PIANO_REQUEST_SEARCH;
    request.data = &data;
    request.responseData = json;
    uint64_t samples[5];
    for (unsigned round = 0; round < 6u; ++round) {
        const uint64_t start = ns_now();
        for (unsigned i = 0; i < iterations; ++i) {
            if (PianoResponse(ph, &request) != PIANO_RET_OK ||
                    PianoListCount((PianoListHead_t *)data.searchResult.artists) != entries ||
                    PianoListCount((PianoListHead_t *)data.searchResult.songs) != entries) abort();
            assert(strcmp(data.searchResult.artists->name, "Race artist") == 0);
            assert(strcmp(data.searchResult.songs->musicId, "song-token") == 0);
            sink += (unsigned char)data.searchResult.songs->title[0];
            PianoDestroySearchResult(&data.searchResult);
            memset(&data.searchResult, 0, sizeof(data.searchResult));
        }
        if (round != 0u) samples[round - 1u] = ns_now() - start;
    }
    printf("search_parse_%zu %.3f requests/s median_of=5 iterations=%u\n",
           entries, (double)iterations * 1e9 / (double)median(samples), iterations);
    free(json);
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const size_t entries = (size_t)strtoul(argv[2], NULL, 10);
    const unsigned iterations = (unsigned)strtoul(argv[3], NULL, 10);
    if (entries == 0 || entries > 65536u || iterations == 0) return 2;
#ifdef MELODICA_REFERENCE_UPSTREAM
    if (gcry_check_version(NULL) == NULL) return 90;
#endif
    PianoHandle_t ph;
    if (PianoInit(&ph, "partner", "password", "device", "abcdefgh", "ijklmnop") != PIANO_RET_OK) return 1;
    if (strcmp(argv[1], "playlist") == 0) bench_response(&ph, entries, iterations);
    else if (strcmp(argv[1], "search") == 0) bench_search(&ph, entries, iterations);
    else { PianoDestroy(&ph); return 2; }
    PianoDestroy(&ph);
    return 0;
}
