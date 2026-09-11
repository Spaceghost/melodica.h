#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef MELODICA_HEADER
#define MELODICA_HEADER "dist/melodica.h"
#endif
#define MELODICA_IMPLEMENTATION
#include MELODICA_HEADER

#define CHECK(x) do { \
  if (!(x)) { \
    fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #x); \
    return 1; \
  } \
} while (0)

static int bytes_eq(const char *p, size_t n, const char *want) {
  return n == strlen(want) && memcmp(p, want, n) == 0;
}

static int slice_eq(const char *json, melodica_slice s, const char *want) {
  return bytes_eq(json + s.offset, s.length, want);
}

int main(void) {
  size_t off = 0, len = 0, written = 0;
  int b = -1;
  uint64_t u = 0;
  char out[512];

  CHECK(melodica_version() == MELODICA_VERSION);

  {
    const char json[] =
      "{\"note\":\"ignore \\\"authToken\\\":\\\"trap\\\" here\","
      "\"authToken\":\"token-123\",\"allowSkip\":false,"
      "\"trackLength\":188,\"escaped\":\"a\\\\b\\\"c\"}";
    CHECK(melodica_find_string(json, sizeof json - 1, "authToken", 9, &off, &len) == MELODICA_OK);
    CHECK(bytes_eq(json + off, len, "token-123"));
    CHECK(melodica_find_bool(json, sizeof json - 1, "allowSkip", 9, &b) == MELODICA_OK);
    CHECK(b == 0);
    CHECK(melodica_find_u64(json, sizeof json - 1, "trackLength", 11, &u) == MELODICA_OK);
    CHECK(u == 188);
    CHECK(melodica_find_string(json, sizeof json - 1, "missing", 7, &off, &len) == MELODICA_NOT_FOUND);
  }

  {
    const char track_json[] =
      "{\"albumTitle\":\"An Album\",\"artistName\":\"An Artist\","
      "\"songTitle\":\"A Song\",\"trackToken\":\"PT-token\","
      "\"stationId\":\"3793312577613735337\",\"trackLength\":188,"
      "\"allowSkip\":true,\"audioEncoding\":\"aacplus\","
      "\"audioURL\":\"https://audio.example.invalid/a\"}";
    melodica_track_view track;
    CHECK(melodica_parse_track(track_json, sizeof track_json - 1, &track) == MELODICA_OK);
    CHECK(track.present == MELODICA_TRACK_ALL);
    CHECK(slice_eq(track_json, track.song_title, "A Song"));
    CHECK(slice_eq(track_json, track.artist_name, "An Artist"));
    CHECK(slice_eq(track_json, track.album_title, "An Album"));
    CHECK(slice_eq(track_json, track.track_token, "PT-token"));
    CHECK(slice_eq(track_json, track.station_id, "3793312577613735337"));
    CHECK(slice_eq(track_json, track.audio_url, "https://audio.example.invalid/a"));
    CHECK(slice_eq(track_json, track.audio_encoding, "aacplus"));
    CHECK(track.track_length == 188);
    CHECK(track.allow_skip == 1);
  }

  {
    const char partial[] = "{\"songTitle\":\"Only a title\"}";
    melodica_track_view track;
    CHECK(melodica_parse_track(partial, sizeof partial - 1, &track) == MELODICA_OK);
    CHECK(track.present == MELODICA_TRACK_SONG_TITLE);
    CHECK(slice_eq(partial, track.song_title, "Only a title"));
    CHECK(track.artist_name.length == 0);
    CHECK(track.track_length == 0);
    CHECK(track.allow_skip == 0);
  }

  {
    const char bad_track[] = "{\"songTitle\":\"fine\",\"trackLength\":123oops}";
    melodica_track_view track;
    CHECK(melodica_parse_track(bad_track, sizeof bad_track - 1, &track) == MELODICA_INVALID_JSON);
  }

  {
    const char json[] = "{\"n\":18446744073709551615}";
    CHECK(melodica_find_u64(json, sizeof json - 1, "n", 1, &u) == MELODICA_OK);
    CHECK(u == UINT64_MAX);
  }

  {
    const char json[] = "{\"n\":18446744073709551616}";
    CHECK(melodica_find_u64(json, sizeof json - 1, "n", 1, &u) == MELODICA_OVERFLOW);
  }

  {
    const char bad_bool[] = "{\"x\":trueish}";
    const char bad_num[] = "{\"x\":123oops}";
    const char leading_zero[] = "{\"x\":01}";
    CHECK(melodica_find_bool(bad_bool, sizeof bad_bool - 1, "x", 1, &b) == MELODICA_INVALID_JSON);
    CHECK(melodica_find_u64(bad_num, sizeof bad_num - 1, "x", 1, &u) == MELODICA_INVALID_JSON);
    CHECK(melodica_find_u64(leading_zero, sizeof leading_zero - 1, "x", 1, &u) == MELODICA_INVALID_JSON);
  }

  {
    const char unterminated[] = "{\"x\":\"unterminated}";
    const char bad_escape[] = "{\"x\":\"bad\\q\"}";
    const char bad_unicode[] = "{\"x\":\"bad\\u12xz\"}";
    const char good_unicode[] = "{\"x\":\"ok\\u263a\"}";
    CHECK(melodica_find_string(unterminated, sizeof unterminated - 1, "x", 1, &off, &len) == MELODICA_INVALID_JSON);
    CHECK(melodica_find_string(bad_escape, sizeof bad_escape - 1, "x", 1, &off, &len) == MELODICA_INVALID_JSON);
    CHECK(melodica_find_string(bad_unicode, sizeof bad_unicode - 1, "x", 1, &off, &len) == MELODICA_INVALID_JSON);
    CHECK(melodica_find_string(good_unicode, sizeof good_unicode - 1, "x", 1, &off, &len) == MELODICA_OK);
    CHECK(bytes_eq(good_unicode + off, len, "ok\\u263a"));
  }

  CHECK(melodica_json_escape("a\n\"b\\c", 6, out, sizeof out, &written) == MELODICA_OK);
  CHECK(bytes_eq(out, written, "a\\n\\\"b\\\\c"));

  CHECK(melodica_login_body("u\"ser", 5, "p\\ass", 5,
                            out, sizeof out, &written) == MELODICA_OK);
  CHECK(bytes_eq(out, written, "{\"username\":\"u\\\"ser\",\"password\":\"p\\\\ass\"}"));

  CHECK(melodica_stations_body(250, 10, out, sizeof out, &written) == MELODICA_OK);
  CHECK(bytes_eq(out, written, "{\"pageSize\":250,\"startIndex\":10}"));

  CHECK(melodica_playlist_body("12345", 5, 1, "aacplus", 7,
                               out, sizeof out, &written) == MELODICA_OK);
  CHECK(bytes_eq(out, written,
    "{\"stationId\":\"12345\",\"isStationStart\":true,"
    "\"fragmentRequestReason\":\"Normal\",\"audioFormat\":\"aacplus\"}"));

  CHECK(melodica_feedback_body("tok", 3, 0, out, sizeof out, &written) == MELODICA_OK);
  CHECK(bytes_eq(out, written, "{\"trackToken\":\"tok\",\"isPositive\":false}"));

  {
    char tiny[4];
    written = 0;
    CHECK(melodica_login_body("u", 1, "p", 1, tiny, sizeof tiny, &written) == MELODICA_NO_SPACE);
    CHECK(written <= sizeof tiny);
  }

  CHECK(melodica_parse_track(NULL, 0, (melodica_track_view *)out) == MELODICA_BAD_ARGUMENT);
  CHECK(melodica_find_string(NULL, 0, "x", 1, &off, &len) == MELODICA_BAD_ARGUMENT);
  CHECK(melodica_json_escape(NULL, 0, out, sizeof out, &written) == MELODICA_BAD_ARGUMENT);

  puts("ok");
  return 0;
}
