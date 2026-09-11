#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#ifndef MELODICA_HEADER
#define MELODICA_HEADER "dist/melodica.h"
#endif
#include MELODICA_HEADER

static const char payload[] =
"{\"tracks\":[{\"userSeed\":\"G1473\",\"genre\":[\"Rock\"],"
"\"monthlyListening\":0,\"listeningTimestamp\":\"1512414066099\","
"\"shareLandingURL\":\"https://example.invalid/share\",\"isSeed\":false,"
"\"allowStartStationFromTrack\":true,\"allowShareTrack\":true,"
"\"allowBuyTrack\":true,\"allowTiredOfTrack\":true,"
"\"allowSkipTrackWithoutLimit\":false,\"allowSkip\":true,"
"\"allowFeedback\":true,\"composerName\":\"\","
"\"artistSeoToken\":\"artist/token\",\"albumSeoToken\":\"album/token\","
"\"isCompilation\":false,\"amazonUrl\":\"https://example.invalid/a\","
"\"albumTitle\":\"An Album\",\"artistName\":\"An Artist\","
"\"songTitle\":\"A Song\",\"trackToken\":\"PT-long-token-for-benchmark-0123456789\","
"\"identity\":\"41561d0348209a43fd397f2baa1b41ad\",\"trackLength\":188,"
"\"stationId\":\"3793312577613735337\",\"fileGain\":\"-3.75\","
"\"audioEncoding\":\"aacplus\",\"audioTokenId\":\"jp6ta2492\","
"\"audioURL\":\"https://audio.example.invalid/access/long/path?token=abcdef0123456789\","
"\"rights\":[\"replayRequiresReward\",\"allowSkipAfterLimit\",\"allowReplay\"]}]}";

static volatile uint64_t sink;

static double lookup_benchmark(void) {
  const size_t loops = 250000;
  clock_t begin = clock();
  size_t off, len;
  int b;
  uint64_t u;

  for (size_t i = 0; i < loops; ++i) {
    sink += (uint64_t)melodica_find_string(payload, sizeof payload - 1, "audioURL", 8, &off, &len);
    sink += len;
    sink += (uint64_t)melodica_find_string(payload, sizeof payload - 1, "trackToken", 10, &off, &len);
    sink += len;
    sink += (uint64_t)melodica_find_string(payload, sizeof payload - 1, "artistName", 10, &off, &len);
    sink += len;
    sink += (uint64_t)melodica_find_u64(payload, sizeof payload - 1, "trackLength", 11, &u);
    sink += u;
    sink += (uint64_t)melodica_find_bool(payload, sizeof payload - 1, "allowSkip", 9, &b);
    sink += (uint64_t)b;
  }

  clock_t end = clock();
  return ((double)(end - begin) / CLOCKS_PER_SEC) * 1000000000.0 /
         ((double)loops * 5.0);
}

static double track_benchmark(void) {
  const size_t loops = 100000;
  clock_t begin = clock();
  melodica_track_view track;

  for (size_t i = 0; i < loops; ++i) {
    sink += (uint64_t)melodica_parse_track(payload, sizeof payload - 1, &track);
    sink += track.present;
    sink += track.track_length;
    sink += track.audio_url.length;
  }

  clock_t end = clock();
  return ((double)(end - begin) / CLOCKS_PER_SEC) * 1000000000.0 /
         (double)loops;
}

int main(int argc, char **argv) {
  double ns = (argc > 1 && argv[1][0] == 't') ? track_benchmark() : lookup_benchmark();
  printf("%.0f\n", ns);
  return sink == UINT64_MAX ? 1 : 0;
}
