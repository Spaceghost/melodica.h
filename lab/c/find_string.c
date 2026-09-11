#include "../abi.h"

static int is_ws(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static int is_hex(unsigned char c) {
    return (c >= '0' && c <= '9') ||
           (c >= 'a' && c <= 'f') ||
           (c >= 'A' && c <= 'F');
}

static int boundary(const unsigned char *json, size_t len, size_t pos) {
    if (pos >= len) return 1;
    const unsigned char c = json[pos];
    return is_ws(c) || c == ',' || c == ']' || c == '}';
}

static int quote_is_escaped(const unsigned char *json, size_t pos) {
    size_t n = 0;
    while (pos > 0 && json[--pos] == '\\') ++n;
    return (n & 1u) != 0;
}

static size_t skip_ws(const unsigned char *json, size_t len, size_t pos) {
    while (pos < len && is_ws(json[pos])) ++pos;
    return pos;
}

static int parse_string(const unsigned char *json, size_t len, size_t pos,
                        size_t *off, size_t *out_len) {
    pos = skip_ws(json, len, pos);
    if (pos >= len || json[pos] != '"') return LAB_INVALID_JSON;

    const size_t start = ++pos;
    while (pos < len) {
        const unsigned char c = json[pos];
        if (c == '\\') {
            if (++pos >= len) return LAB_INVALID_JSON;
            const unsigned char e = json[pos];
            if (e == 'u') {
                if (pos + 4 >= len || !is_hex(json[pos+1]) ||
                    !is_hex(json[pos+2]) || !is_hex(json[pos+3]) ||
                    !is_hex(json[pos+4])) return LAB_INVALID_JSON;
                pos += 5;
                continue;
            }
            if (!(e == '"' || e == '\\' || e == '/' || e == 'b' ||
                  e == 'f' || e == 'n' || e == 'r' || e == 't'))
                return LAB_INVALID_JSON;
            ++pos;
            continue;
        }
        if (c == '"') {
            if (!boundary(json, len, pos + 1)) return LAB_INVALID_JSON;
            *off = start;
            *out_len = pos - start;
            return LAB_OK;
        }
        if (c < 0x20) return LAB_INVALID_JSON;
        ++pos;
    }
    return LAB_INVALID_JSON;
}

int lab_find_string(const char *json_, size_t json_len,
                    const char *key_, size_t key_len,
                    size_t *value_offset, size_t *value_len) {
    if (!json_ || !key_ || !value_offset || !value_len) return LAB_BAD_ARGUMENT;
    const unsigned char *json = (const unsigned char *)json_;
    const unsigned char *key = (const unsigned char *)key_;
    if (key_len + 2 > json_len) return LAB_NOT_FOUND;

    for (size_t i = 0; i + key_len + 2 <= json_len; ++i) {
        if (json[i] != '"' || quote_is_escaped(json, i)) continue;
        size_t k = 0;
        while (k < key_len && json[i + 1 + k] == key[k]) ++k;
        if (k != key_len || json[i + 1 + key_len] != '"') continue;
        const size_t after = skip_ws(json, json_len, i + key_len + 2);
        if (after < json_len && json[after] == ':')
            return parse_string(json, json_len, after + 1,
                                value_offset, value_len);
    }
    return LAB_NOT_FOUND;
}
