/* melodica.h - generated single-header C99 library
 *
 * Source: https://github.com/Spaceghost/melodica.h
 * License: MIT
 *
 * Define MELODICA_IMPLEMENTATION in exactly one translation unit before
 * including this file to compile the implementation.
 */
#ifndef MELODICA_H_INCLUDED
#define MELODICA_H_INCLUDED

#include <stddef.h>
#include <stdint.h>

#ifndef MELODICA_API
#define MELODICA_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define MELODICA_VERSION_MAJOR 0
#define MELODICA_VERSION_MINOR 2
#define MELODICA_VERSION_PATCH 0
#define MELODICA_VERSION ((MELODICA_VERSION_MAJOR << 16) | (MELODICA_VERSION_MINOR << 8) | MELODICA_VERSION_PATCH)

#define MELODICA_ENDPOINT_LOGIN        "/api/v1/auth/login"
#define MELODICA_ENDPOINT_STATIONS     "/api/v1/station/getStations"
#define MELODICA_ENDPOINT_PLAYLIST     "/api/v1/playlist/getFragment"
#define MELODICA_ENDPOINT_FEEDBACK     "/api/v1/station/addFeedback"

#define MELODICA_OK             0
#define MELODICA_NOT_FOUND      1
#define MELODICA_INVALID_JSON   2
#define MELODICA_NO_SPACE       3
#define MELODICA_BAD_ARGUMENT   4
#define MELODICA_OVERFLOW       5

typedef struct melodica_slice {
    size_t offset;
    size_t length;
} melodica_slice;

#define MELODICA_TRACK_SONG_TITLE      UINT32_C(1)
#define MELODICA_TRACK_ARTIST_NAME     UINT32_C(2)
#define MELODICA_TRACK_ALBUM_TITLE     UINT32_C(4)
#define MELODICA_TRACK_TOKEN           UINT32_C(8)
#define MELODICA_TRACK_STATION_ID      UINT32_C(16)
#define MELODICA_TRACK_AUDIO_URL       UINT32_C(32)
#define MELODICA_TRACK_AUDIO_ENCODING  UINT32_C(64)
#define MELODICA_TRACK_LENGTH          UINT32_C(128)
#define MELODICA_TRACK_ALLOW_SKIP      UINT32_C(256)
#define MELODICA_TRACK_ALL             UINT32_C(511)

typedef struct melodica_track_view {
    uint32_t present;
    melodica_slice song_title;
    melodica_slice artist_name;
    melodica_slice album_title;
    melodica_slice track_token;
    melodica_slice station_id;
    melodica_slice audio_url;
    melodica_slice audio_encoding;
    uint64_t track_length;
    int allow_skip;
} melodica_track_view;

MELODICA_API unsigned melodica_version(void);

MELODICA_API int melodica_find_string(const char *json, size_t json_len,
                                      const char *key, size_t key_len,
                                      size_t *value_offset, size_t *value_len);

MELODICA_API int melodica_find_bool(const char *json, size_t json_len,
                                    const char *key, size_t key_len,
                                    int *value);

MELODICA_API int melodica_find_u64(const char *json, size_t json_len,
                                   const char *key, size_t key_len,
                                   uint64_t *value);

MELODICA_API int melodica_parse_track(const char *json, size_t json_len,
                                      melodica_track_view *track);

MELODICA_API int melodica_json_escape(const char *input, size_t input_len,
                                      char *output, size_t output_cap,
                                      size_t *output_len);

MELODICA_API int melodica_login_body(const char *username, size_t username_len,
                                     const char *password, size_t password_len,
                                     char *output, size_t output_cap,
                                     size_t *output_len);

MELODICA_API int melodica_stations_body(unsigned page_size, unsigned start_index,
                                        char *output, size_t output_cap,
                                        size_t *output_len);

MELODICA_API int melodica_playlist_body(const char *station_id, size_t station_id_len,
                                        int station_start,
                                        const char *audio_format, size_t audio_format_len,
                                        char *output, size_t output_cap,
                                        size_t *output_len);

MELODICA_API int melodica_feedback_body(const char *track_token, size_t track_token_len,
                                        int positive,
                                        char *output, size_t output_cap,
                                        size_t *output_len);

#ifdef __cplusplus
} /* extern "C" */
#endif

#ifdef MELODICA_IMPLEMENTATION
#ifndef MELODICA_IMPLEMENTATION_ONCE
#define MELODICA_IMPLEMENTATION_ONCE

/* ---- generated implementation follows ---- */
/* ------------------------------ DIRECTIVES -------------------------------- */
/* Enable 64 bit offsets for stdio APIs. */
#if !defined(_FILE_OFFSET_BITS) && __SIZEOF_LONG__ >= 8
  #define _FILE_OFFSET_BITS 64
#endif
/* Enable POSIX APIs in included headers. */
#if !defined(_POSIX_C_SOURCE) && !defined(_XOPEN_SOURCE) && !defined(_GNU_SOURCE) && !defined(_DEFAULT_SOURCE)
  #if defined(__gnu_linux__)
    #define _GNU_SOURCE
  #else
    #define _XOPEN_SOURCE 600
  #endif
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* ------------------------------ DECLARATIONS ------------------------------ */
static bool m_is_ws(char c);
static bool m_is_hex(char c);
typedef char* nlcchar_arr0_ptr;
static bool m_is_boundary(nlcchar_arr0_ptr json, size_t json_len, size_t pos);
static size_t m_melodica_skip_ws(nlcchar_arr0_ptr json, size_t json_len, size_t pos);
typedef size_t* nlcsize_ptr;
static int m_melodica_parse_string_at(nlcchar_arr0_ptr json, size_t json_len, size_t pos, nlcsize_ptr value_offset, nlcsize_ptr value_len);
typedef int* nlcint_ptr;
static int m_melodica_parse_bool_at(nlcchar_arr0_ptr json, size_t json_len, size_t pos, nlcint_ptr value);
typedef uint64_t* nluint64_ptr;
static int m_melodica_parse_u64_at(nlcchar_arr0_ptr json, size_t json_len, size_t pos, nluint64_ptr value);
static bool m_putc(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, char c);
static bool m_append(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, const char* input, size_t input_len);
static bool m_append_u64(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, uint64_t value);
static bool m_append_bool(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, int value);
static char m_hex_digit(uint8_t v);
static bool m_append_escaped(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, nlcchar_arr0_ptr input, size_t input_len);
static bool m_quote_is_escaped(nlcchar_arr0_ptr json, size_t pos);
static int m_locate(nlcchar_arr0_ptr json, size_t json_len, nlcchar_arr0_ptr key, size_t key_len, nlcsize_ptr value_pos);
typedef melodica_slice* melodica_slice_ptr;
static void m_clear_slice(melodica_slice_ptr dst);
typedef melodica_track_view* melodica_track_view_ptr;
static int m_capture_string(const char* json, size_t json_len, const char* key, size_t key_len, melodica_slice_ptr dst, melodica_track_view_ptr track, uint32_t flag);
static int m_capture_u64(const char* json, size_t json_len, const char* key, size_t key_len, nluint64_ptr dst, melodica_track_view_ptr track, uint32_t flag);
static int m_capture_bool(const char* json, size_t json_len, const char* key, size_t key_len, nlcint_ptr dst, melodica_track_view_ptr track, uint32_t flag);
/* ------------------------------ DEFINITIONS ------------------------------- */
bool m_is_ws(char c) {
  return (((c == 32 || c == 9) || c == 10) || c == 13);
}
bool m_is_hex(char c) {
  return (((c >= 48 && c <= 57) || (c >= 65 && c <= 70)) || (c >= 97 && c <= 102));
}
bool m_is_boundary(nlcchar_arr0_ptr json, size_t json_len, size_t pos) {
  if(pos >= json_len) {
    return true;
  }
  char c = json[pos];
  return (((m_is_ws(c) || c == 44) || c == 93) || c == 125);
}
size_t m_melodica_skip_ws(nlcchar_arr0_ptr json, size_t json_len, size_t pos) {
  while((pos < json_len && m_is_ws(json[pos]))) {
    pos = (pos + 1);
  }
  return pos;
}
int m_melodica_parse_string_at(nlcchar_arr0_ptr json, size_t json_len, size_t pos, nlcsize_ptr value_offset, nlcsize_ptr value_len) {
  pos = m_melodica_skip_ws(json, json_len, pos);
  if((pos >= json_len || json[pos] != 34)) {
    return 2;
  }
  size_t start = (pos + 1);
  pos = start;
  while(pos < json_len) {
    char c = json[pos];
    if(c == 92) {
      pos = (pos + 1);
      if(pos >= json_len) {
        return 2;
      }
      char esc = json[pos];
      if(esc == 117) {
        if((pos + 4) >= json_len) {
          return 2;
        }
        if(((((!m_is_hex(json[(pos + 1)])) || (!m_is_hex(json[(pos + 2)]))) || (!m_is_hex(json[(pos + 3)]))) || (!m_is_hex(json[(pos + 4)])))) {
          return 2;
        }
        pos = (pos + 5);
      } else if((((((((esc == 34 || esc == 92) || esc == 47) || esc == 98) || esc == 102) || esc == 110) || esc == 114) || esc == 116)) {
        pos = (pos + 1);
      } else {
        return 2;
      }
    } else if(c == 34) {
      if((!m_is_boundary(json, json_len, (pos + 1)))) {
        return 2;
      }
      (*value_offset) = start;
      (*value_len) = (pos - start);
      return 0;
    } else if((c >= 0 && c < 32)) {
      return 2;
    } else {
      pos = (pos + 1);
    }
  }
  return 2;
}
int m_melodica_parse_bool_at(nlcchar_arr0_ptr json, size_t json_len, size_t pos, nlcint_ptr value) {
  pos = m_melodica_skip_ws(json, json_len, pos);
  if(((((((pos + 4) <= json_len && json[pos] == 116) && json[(pos + 1)] == 114) && json[(pos + 2)] == 117) && json[(pos + 3)] == 101) && m_is_boundary(json, json_len, (pos + 4)))) {
    (*value) = 1;
    return 0;
  }
  if((((((((pos + 5) <= json_len && json[pos] == 102) && json[(pos + 1)] == 97) && json[(pos + 2)] == 108) && json[(pos + 3)] == 115) && json[(pos + 4)] == 101) && m_is_boundary(json, json_len, (pos + 5)))) {
    (*value) = 0;
    return 0;
  }
  return 2;
}
int m_melodica_parse_u64_at(nlcchar_arr0_ptr json, size_t json_len, size_t pos, nluint64_ptr value) {
  pos = m_melodica_skip_ws(json, json_len, pos);
  if(((pos >= json_len || json[pos] < 48) || json[pos] > 57)) {
    return 2;
  }
  if((((json[pos] == 48 && (pos + 1) < json_len) && json[(pos + 1)] >= 48) && json[(pos + 1)] <= 57)) {
    return 2;
  }
  uint64_t v = 0U;
  while(pos < json_len) {
    char c = json[pos];
    if((c < 48 || c > 57)) {
      break;
    }
    uint64_t digit = (uint64_t)(c - 48);
    if((v > 1844674407370955161ULL || (v == 1844674407370955161ULL && digit > 5))) {
      return 5;
    }
    v = ((v * 10) + digit);
    pos = (pos + 1);
  }
  if((!m_is_boundary(json, json_len, pos))) {
    return 2;
  }
  (*value) = v;
  return 0;
}
bool m_putc(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, char c) {
  if((*pos) >= output_cap) {
    return false;
  }
  output[(*pos)] = c;
  (*pos) = ((*pos) + 1);
  return true;
}
bool m_append(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, const char* input, size_t input_len) {
  nlcchar_arr0_ptr bytes = ((nlcchar_arr0_ptr)input);
  if(((*pos) > output_cap || input_len > (output_cap - (*pos)))) {
    return false;
  }
  size_t i = 0U;
  while(i < input_len) {
    output[(*pos)] = bytes[i];
    (*pos) = ((*pos) + 1);
    i = (i + 1);
  }
  return true;
}
bool m_append_u64(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, uint64_t value) {
  uint64_t divisor = 1U;
  uint64_t remaining = value;
  while(remaining >= 10) {
    remaining = (remaining / 10);
    divisor = (divisor * 10);
  }
  while(divisor > 0) {
    char digit = (char)(48 + ((value / divisor) % 10));
    if((!m_putc(output, output_cap, pos, digit))) {
      return false;
    }
    divisor = (divisor / 10);
  }
  return true;
}
bool m_append_bool(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, int value) {
  if(value != 0) {
    return m_append(output, output_cap, pos, (char*)"true", 4U);
  }
  return m_append(output, output_cap, pos, (char*)"false", 5U);
}
char m_hex_digit(uint8_t v) {
  if(v < 10) {
    return (char)(48 + v);
  }
  return (char)(87 + v);
}
bool m_append_escaped(nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr pos, nlcchar_arr0_ptr input, size_t input_len) {
  size_t i = 0U;
  while(i < input_len) {
    char c = input[i];
    if((c == 34 || c == 92)) {
      if(((!m_putc(output, output_cap, pos, 92)) || (!m_putc(output, output_cap, pos, c)))) {
        return false;
      }
    } else if(c == 8) {
      if((!m_append(output, output_cap, pos, (char*)"\\b", 2U))) {
        return false;
      }
    } else if(c == 12) {
      if((!m_append(output, output_cap, pos, (char*)"\\f", 2U))) {
        return false;
      }
    } else if(c == 10) {
      if((!m_append(output, output_cap, pos, (char*)"\\n", 2U))) {
        return false;
      }
    } else if(c == 13) {
      if((!m_append(output, output_cap, pos, (char*)"\\r", 2U))) {
        return false;
      }
    } else if(c == 9) {
      if((!m_append(output, output_cap, pos, (char*)"\\t", 2U))) {
        return false;
      }
    } else if((c >= 0 && c < 32)) {
      if((!m_append(output, output_cap, pos, (char*)"\\u00", 4U))) {
        return false;
      }
      uint8_t u = (uint8_t)c;
      if(((!m_putc(output, output_cap, pos, m_hex_digit((u / 16)))) || (!m_putc(output, output_cap, pos, m_hex_digit((u % 16)))))) {
        return false;
      }
    } else {
      if((!m_putc(output, output_cap, pos, c))) {
        return false;
      }
    }
    i = (i + 1);
  }
  return true;
}
unsigned int melodica_version(void) {
  return 512U;
}
int melodica_json_escape(const char* input, size_t input_len, nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr output_len) {
  if(((input == (char*)NULL || output == ((nlcchar_arr0_ptr)NULL)) || output_len == (nlcsize_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr input_bytes = ((nlcchar_arr0_ptr)input);
  size_t pos = 0U;
  if((!m_append_escaped(output, output_cap, (&pos), input_bytes, input_len))) {
    (*output_len) = pos;
    return 3;
  }
  (*output_len) = pos;
  return 0;
}
int melodica_login_body(const char* username, size_t username_len, const char* password, size_t password_len, nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr output_len) {
  if((((username == (char*)NULL || password == (char*)NULL) || output == ((nlcchar_arr0_ptr)NULL)) || output_len == (nlcsize_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr username_bytes = ((nlcchar_arr0_ptr)username);
  nlcchar_arr0_ptr password_bytes = ((nlcchar_arr0_ptr)password);
  size_t pos = 0U;
  if((((((!m_append(output, output_cap, (&pos), (char*)"{\"username\":\"", 13U)) || (!m_append_escaped(output, output_cap, (&pos), username_bytes, username_len))) || (!m_append(output, output_cap, (&pos), (char*)"\",\"password\":\"", 14U))) || (!m_append_escaped(output, output_cap, (&pos), password_bytes, password_len))) || (!m_append(output, output_cap, (&pos), (char*)"\"}", 2U)))) {
    (*output_len) = pos;
    return 3;
  }
  (*output_len) = pos;
  return 0;
}
int melodica_stations_body(unsigned int page_size, unsigned int start_index, nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr output_len) {
  if((output == ((nlcchar_arr0_ptr)NULL) || output_len == (nlcsize_ptr)NULL)) {
    return 4;
  }
  size_t pos = 0U;
  if((((((!m_append(output, output_cap, (&pos), (char*)"{\"pageSize\":", 12U)) || (!m_append_u64(output, output_cap, (&pos), (uint64_t)page_size))) || (!m_append(output, output_cap, (&pos), (char*)",\"startIndex\":", 14U))) || (!m_append_u64(output, output_cap, (&pos), (uint64_t)start_index))) || (!m_putc(output, output_cap, (&pos), 125)))) {
    (*output_len) = pos;
    return 3;
  }
  (*output_len) = pos;
  return 0;
}
int melodica_playlist_body(const char* station_id, size_t station_id_len, int station_start, const char* audio_format, size_t audio_format_len, nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr output_len) {
  if((((station_id == (char*)NULL || audio_format == (char*)NULL) || output == ((nlcchar_arr0_ptr)NULL)) || output_len == (nlcsize_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr station_bytes = ((nlcchar_arr0_ptr)station_id);
  nlcchar_arr0_ptr format_bytes = ((nlcchar_arr0_ptr)audio_format);
  size_t pos = 0U;
  if((((((((!m_append(output, output_cap, (&pos), (char*)"{\"stationId\":\"", 14U)) || (!m_append_escaped(output, output_cap, (&pos), station_bytes, station_id_len))) || (!m_append(output, output_cap, (&pos), (char*)"\",\"isStationStart\":", 19U))) || (!m_append_bool(output, output_cap, (&pos), station_start))) || (!m_append(output, output_cap, (&pos), (char*)",\"fragmentRequestReason\":\"Normal\",\"audioFormat\":\"", 49U))) || (!m_append_escaped(output, output_cap, (&pos), format_bytes, audio_format_len))) || (!m_append(output, output_cap, (&pos), (char*)"\"}", 2U)))) {
    (*output_len) = pos;
    return 3;
  }
  (*output_len) = pos;
  return 0;
}
int melodica_feedback_body(const char* track_token, size_t track_token_len, int positive, nlcchar_arr0_ptr output, size_t output_cap, nlcsize_ptr output_len) {
  if(((track_token == (char*)NULL || output == ((nlcchar_arr0_ptr)NULL)) || output_len == (nlcsize_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr token_bytes = ((nlcchar_arr0_ptr)track_token);
  size_t pos = 0U;
  if((((((!m_append(output, output_cap, (&pos), (char*)"{\"trackToken\":\"", 15U)) || (!m_append_escaped(output, output_cap, (&pos), token_bytes, track_token_len))) || (!m_append(output, output_cap, (&pos), (char*)"\",\"isPositive\":", 15U))) || (!m_append_bool(output, output_cap, (&pos), positive))) || (!m_putc(output, output_cap, (&pos), 125)))) {
    (*output_len) = pos;
    return 3;
  }
  (*output_len) = pos;
  return 0;
}
bool m_quote_is_escaped(nlcchar_arr0_ptr json, size_t pos) {
  if(pos == 0) {
    return false;
  }
  size_t n = 0U;
  size_t i = pos;
  while(i > 0) {
    i = (i - 1);
    if(json[i] != 92) {
      break;
    }
    n = (n + 1);
  }
  return ((n % 2) != 0);
}
int m_locate(nlcchar_arr0_ptr json, size_t json_len, nlcchar_arr0_ptr key, size_t key_len, nlcsize_ptr value_pos) {
  if((key_len + 2) > json_len) {
    return 1;
  }
  size_t i = 0U;
  while(((i + key_len) + 2) <= json_len) {
    if((json[i] == 34 && (!m_quote_is_escaped(json, i)))) {
      size_t k = 0U;
      while((k < key_len && json[((i + 1) + k)] == key[k])) {
        k = (k + 1);
      }
      if((k == key_len && json[((i + 1) + key_len)] == 34)) {
        size_t after = m_melodica_skip_ws(json, json_len, ((i + key_len) + 2));
        if((after < json_len && json[after] == 58)) {
          (*value_pos) = (after + 1);
          return 0;
        }
      }
    }
    i = (i + 1);
  }
  return 1;
}
int melodica_find_string(const char* json, size_t json_len, const char* key, size_t key_len, nlcsize_ptr value_offset, nlcsize_ptr value_len) {
  if((((json == (char*)NULL || key == (char*)NULL) || value_offset == (nlcsize_ptr)NULL) || value_len == (nlcsize_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr json_bytes = ((nlcchar_arr0_ptr)json);
  nlcchar_arr0_ptr key_bytes = ((nlcchar_arr0_ptr)key);
  size_t pos = 0U;
  int status = m_locate(json_bytes, json_len, key_bytes, key_len, (&pos));
  if(status != 0) {
    return status;
  }
  return m_melodica_parse_string_at(json_bytes, json_len, pos, value_offset, value_len);
}
int melodica_find_bool(const char* json, size_t json_len, const char* key, size_t key_len, nlcint_ptr value) {
  if(((json == (char*)NULL || key == (char*)NULL) || value == (nlcint_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr json_bytes = ((nlcchar_arr0_ptr)json);
  nlcchar_arr0_ptr key_bytes = ((nlcchar_arr0_ptr)key);
  size_t pos = 0U;
  int status = m_locate(json_bytes, json_len, key_bytes, key_len, (&pos));
  if(status != 0) {
    return status;
  }
  return m_melodica_parse_bool_at(json_bytes, json_len, pos, value);
}
int melodica_find_u64(const char* json, size_t json_len, const char* key, size_t key_len, nluint64_ptr value) {
  if(((json == (char*)NULL || key == (char*)NULL) || value == (nluint64_ptr)NULL)) {
    return 4;
  }
  nlcchar_arr0_ptr json_bytes = ((nlcchar_arr0_ptr)json);
  nlcchar_arr0_ptr key_bytes = ((nlcchar_arr0_ptr)key);
  size_t pos = 0U;
  int status = m_locate(json_bytes, json_len, key_bytes, key_len, (&pos));
  if(status != 0) {
    return status;
  }
  return m_melodica_parse_u64_at(json_bytes, json_len, pos, value);
}
void m_clear_slice(melodica_slice_ptr dst) {
  dst->offset = 0U;
  dst->length = 0U;
}
int m_capture_string(const char* json, size_t json_len, const char* key, size_t key_len, melodica_slice_ptr dst, melodica_track_view_ptr track, uint32_t flag) {
  size_t offset = 0U;
  size_t length = 0U;
  int status = melodica_find_string(json, json_len, key, key_len, (&offset), (&length));
  if(status == 0) {
    dst->offset = offset;
    dst->length = length;
    track->present = (track->present + flag);
    return 0;
  }
  if(status == 1) {
    return 0;
  }
  return status;
}
int m_capture_u64(const char* json, size_t json_len, const char* key, size_t key_len, nluint64_ptr dst, melodica_track_view_ptr track, uint32_t flag) {
  uint64_t value = 0U;
  int status = melodica_find_u64(json, json_len, key, key_len, (&value));
  if(status == 0) {
    (*dst) = value;
    track->present = (track->present + flag);
    return 0;
  }
  if(status == 1) {
    return 0;
  }
  return status;
}
int m_capture_bool(const char* json, size_t json_len, const char* key, size_t key_len, nlcint_ptr dst, melodica_track_view_ptr track, uint32_t flag) {
  int value = 0;
  int status = melodica_find_bool(json, json_len, key, key_len, (&value));
  if(status == 0) {
    (*dst) = value;
    track->present = (track->present + flag);
    return 0;
  }
  if(status == 1) {
    return 0;
  }
  return status;
}
int melodica_parse_track(const char* json, size_t json_len, melodica_track_view_ptr track) {
  if((json == (char*)NULL || track == ((melodica_track_view_ptr)NULL))) {
    return 4;
  }
  track->present = 0U;
  m_clear_slice((&track->song_title));
  m_clear_slice((&track->artist_name));
  m_clear_slice((&track->album_title));
  m_clear_slice((&track->track_token));
  m_clear_slice((&track->station_id));
  m_clear_slice((&track->audio_url));
  m_clear_slice((&track->audio_encoding));
  track->track_length = 0U;
  track->allow_skip = 0;
  int status = m_capture_string(json, json_len, (char*)"songTitle", 9U, (&track->song_title), track, 1U);
  if(status != 0) {
    return status;
  }
  status = m_capture_string(json, json_len, (char*)"artistName", 10U, (&track->artist_name), track, 2U);
  if(status != 0) {
    return status;
  }
  status = m_capture_string(json, json_len, (char*)"albumTitle", 10U, (&track->album_title), track, 4U);
  if(status != 0) {
    return status;
  }
  status = m_capture_string(json, json_len, (char*)"trackToken", 10U, (&track->track_token), track, 8U);
  if(status != 0) {
    return status;
  }
  status = m_capture_string(json, json_len, (char*)"stationId", 9U, (&track->station_id), track, 16U);
  if(status != 0) {
    return status;
  }
  status = m_capture_string(json, json_len, (char*)"audioURL", 8U, (&track->audio_url), track, 32U);
  if(status != 0) {
    return status;
  }
  status = m_capture_string(json, json_len, (char*)"audioEncoding", 13U, (&track->audio_encoding), track, 64U);
  if(status != 0) {
    return status;
  }
  status = m_capture_u64(json, json_len, (char*)"trackLength", 11U, (&track->track_length), track, 128U);
  if(status != 0) {
    return status;
  }
  status = m_capture_bool(json, json_len, (char*)"allowSkip", 9U, (&track->allow_skip), track, 256U);
  if(status != 0) {
    return status;
  }
  return 0;
}

/* ---- end generated implementation ---- */

#endif /* MELODICA_IMPLEMENTATION_ONCE */
#endif /* MELODICA_IMPLEMENTATION */
#endif /* MELODICA_H_INCLUDED */
