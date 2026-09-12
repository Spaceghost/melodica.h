#include "json.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#define JSON_MAX_DEPTH 64u

typedef struct JsonParser {
    MelodicaJsonDoc *doc;
    size_t pos;
    unsigned depth;
} JsonParser;

static int is_space(const char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static int is_hex(const char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
        (c >= 'A' && c <= 'F');
}

static unsigned hex_value(const char c) {
    if (c >= '0' && c <= '9') return (unsigned)(c - '0');
    if (c >= 'a' && c <= 'f') return 10u + (unsigned)(c - 'a');
    return 10u + (unsigned)(c - 'A');
}

static void skip_space(JsonParser *p) {
    while (p->pos < p->doc->length && is_space(p->doc->text[p->pos])) ++p->pos;
}

static size_t add_token(MelodicaJsonDoc *doc, const MelodicaJsonType type,
        const size_t start, const size_t end, const size_t parent) {
    if (doc->count == doc->capacity) {
        const size_t new_capacity = doc->capacity == 0u ? 32u : doc->capacity * 2u;
        if (new_capacity < doc->capacity ||
                new_capacity > (size_t)-1 / sizeof(*doc->tokens)) return MELODICA_JSON_NONE;
        MelodicaJsonToken *tokens = (MelodicaJsonToken *)realloc(doc->tokens,
                new_capacity * sizeof(*tokens));
        if (tokens == NULL) return MELODICA_JSON_NONE;
        doc->tokens = tokens;
        doc->capacity = new_capacity;
    }
    const size_t index = doc->count++;
    doc->tokens[index].type = type;
    doc->tokens[index].start = start;
    doc->tokens[index].end = end;
    doc->tokens[index].parent = parent;
    return index;
}

static int parse_value(JsonParser *p, size_t parent);

static int parse_string(JsonParser *p, const size_t parent) {
    if (p->pos >= p->doc->length || p->doc->text[p->pos] != '"') return 0;
    const size_t start = ++p->pos;
    while (p->pos < p->doc->length) {
        const unsigned char c = (unsigned char)p->doc->text[p->pos];
        if (c == '"') {
            const size_t end = p->pos++;
            return add_token(p->doc, MELODICA_JSON_STRING, start, end, parent) !=
                MELODICA_JSON_NONE;
        }
        if (c < 0x20u) return 0;
        if (c == '\\') {
            ++p->pos;
            if (p->pos >= p->doc->length) return 0;
            const char esc = p->doc->text[p->pos];
            if (strchr("\"\\/bfnrt", esc) != NULL) {
                ++p->pos;
                continue;
            }
            if (esc == 'u') {
                if (p->pos + 4u >= p->doc->length) return 0;
                for (unsigned i = 1u; i <= 4u; ++i) {
                    if (!is_hex(p->doc->text[p->pos + i])) return 0;
                }
                p->pos += 5u;
                continue;
            }
            return 0;
        }
        ++p->pos;
    }
    return 0;
}

static int parse_primitive(JsonParser *p, const size_t parent) {
    const size_t start = p->pos;
    while (p->pos < p->doc->length) {
        const char c = p->doc->text[p->pos];
        if (is_space(c) || c == ',' || c == ']' || c == '}') break;
        if ((unsigned char)c < 0x20u || c == '"' || c == '[' || c == '{' || c == ':') return 0;
        ++p->pos;
    }
    if (p->pos == start) return 0;
    return add_token(p->doc, MELODICA_JSON_PRIMITIVE, start, p->pos, parent) !=
        MELODICA_JSON_NONE;
}

static int parse_object(JsonParser *p, const size_t parent) {
    const size_t start = p->pos;
    const size_t object = add_token(p->doc, MELODICA_JSON_OBJECT, start, start, parent);
    if (object == MELODICA_JSON_NONE) return 0;
    ++p->pos;
    skip_space(p);
    if (p->pos < p->doc->length && p->doc->text[p->pos] == '}') {
        p->doc->tokens[object].end = ++p->pos;
        return 1;
    }
    for (;;) {
        skip_space(p);
        if (!parse_string(p, object)) return 0;
        skip_space(p);
        if (p->pos >= p->doc->length || p->doc->text[p->pos++] != ':') return 0;
        skip_space(p);
        if (!parse_value(p, object)) return 0;
        skip_space(p);
        if (p->pos >= p->doc->length) return 0;
        if (p->doc->text[p->pos] == '}') {
            p->doc->tokens[object].end = ++p->pos;
            return 1;
        }
        if (p->doc->text[p->pos++] != ',') return 0;
    }
}

static int parse_array(JsonParser *p, const size_t parent) {
    const size_t start = p->pos;
    const size_t array = add_token(p->doc, MELODICA_JSON_ARRAY, start, start, parent);
    if (array == MELODICA_JSON_NONE) return 0;
    ++p->pos;
    skip_space(p);
    if (p->pos < p->doc->length && p->doc->text[p->pos] == ']') {
        p->doc->tokens[array].end = ++p->pos;
        return 1;
    }
    for (;;) {
        skip_space(p);
        if (!parse_value(p, array)) return 0;
        skip_space(p);
        if (p->pos >= p->doc->length) return 0;
        if (p->doc->text[p->pos] == ']') {
            p->doc->tokens[array].end = ++p->pos;
            return 1;
        }
        if (p->doc->text[p->pos++] != ',') return 0;
    }
}

static int parse_value(JsonParser *p, const size_t parent) {
    if (++p->depth > JSON_MAX_DEPTH) return 0;
    skip_space(p);
    int ok = 0;
    if (p->pos < p->doc->length) {
        switch (p->doc->text[p->pos]) {
            case '{': ok = parse_object(p, parent); break;
            case '[': ok = parse_array(p, parent); break;
            case '"': ok = parse_string(p, parent); break;
            default: ok = parse_primitive(p, parent); break;
        }
    }
    --p->depth;
    return ok;
}

int melodica_json_parse(MelodicaJsonDoc *doc, const char *text) {
    if (doc == NULL || text == NULL) return 0;
    memset(doc, 0, sizeof(*doc));
    doc->text = text;
    doc->length = strlen(text);
    JsonParser p;
    p.doc = doc;
    p.pos = 0u;
    p.depth = 0u;
    skip_space(&p);
    if (!parse_value(&p, MELODICA_JSON_NONE)) {
        melodica_json_destroy(doc);
        return 0;
    }
    skip_space(&p);
    if (p.pos != doc->length || doc->count == 0u) {
        melodica_json_destroy(doc);
        return 0;
    }
    return 1;
}

void melodica_json_destroy(MelodicaJsonDoc *doc) {
    if (doc == NULL) return;
    free(doc->tokens);
    memset(doc, 0, sizeof(*doc));
}

static int token_raw_is(const MelodicaJsonDoc *doc, const size_t token, const char *value) {
    if (doc == NULL || value == NULL || token >= doc->count) return 0;
    const MelodicaJsonToken *t = &doc->tokens[token];
    const size_t length = t->end - t->start;
    return strlen(value) == length && memcmp(doc->text + t->start, value, length) == 0;
}

size_t melodica_json_object_get(const MelodicaJsonDoc *doc, const size_t object,
        const char *key) {
    if (doc == NULL || object >= doc->count || key == NULL ||
            doc->tokens[object].type != MELODICA_JSON_OBJECT) return MELODICA_JSON_NONE;
    int key_slot = 1;
    int matched = 0;
    for (size_t i = object + 1u; i < doc->count &&
            doc->tokens[i].start < doc->tokens[object].end; ++i) {
        if (doc->tokens[i].parent != object) continue;
        if (key_slot) {
            if (doc->tokens[i].type != MELODICA_JSON_STRING) return MELODICA_JSON_NONE;
            matched = token_raw_is(doc, i, key);
            key_slot = 0;
        } else {
            if (matched) return i;
            key_slot = 1;
        }
    }
    return MELODICA_JSON_NONE;
}

size_t melodica_json_array_count(const MelodicaJsonDoc *doc, const size_t array) {
    if (doc == NULL || array >= doc->count ||
            doc->tokens[array].type != MELODICA_JSON_ARRAY) return 0u;
    size_t count = 0u;
    for (size_t i = array + 1u; i < doc->count &&
            doc->tokens[i].start < doc->tokens[array].end; ++i) {
        if (doc->tokens[i].parent == array) ++count;
    }
    return count;
}

size_t melodica_json_array_get(const MelodicaJsonDoc *doc, const size_t array,
        const size_t position) {
    if (doc == NULL || array >= doc->count ||
            doc->tokens[array].type != MELODICA_JSON_ARRAY) return MELODICA_JSON_NONE;
    size_t current = 0u;
    for (size_t i = array + 1u; i < doc->count &&
            doc->tokens[i].start < doc->tokens[array].end; ++i) {
        if (doc->tokens[i].parent != array) continue;
        if (current++ == position) return i;
    }
    return MELODICA_JSON_NONE;
}

int melodica_json_string_is(const MelodicaJsonDoc *doc, const size_t token,
        const char *value) {
    return doc != NULL && token < doc->count &&
        doc->tokens[token].type == MELODICA_JSON_STRING && token_raw_is(doc, token, value);
}

static int read_u16(const char *p, unsigned *value) {
    unsigned v = 0u;
    for (unsigned i = 0u; i < 4u; ++i) {
        if (!is_hex(p[i])) return 0;
        v = (v << 4u) | hex_value(p[i]);
    }
    *value = v;
    return 1;
}

static char *write_utf8(char *out, const unsigned cp) {
    if (cp <= 0x7fu) {
        *out++ = (char)cp;
    } else if (cp <= 0x7ffu) {
        *out++ = (char)(0xc0u | (cp >> 6u));
        *out++ = (char)(0x80u | (cp & 0x3fu));
    } else if (cp <= 0xffffu) {
        *out++ = (char)(0xe0u | (cp >> 12u));
        *out++ = (char)(0x80u | ((cp >> 6u) & 0x3fu));
        *out++ = (char)(0x80u | (cp & 0x3fu));
    } else {
        *out++ = (char)(0xf0u | (cp >> 18u));
        *out++ = (char)(0x80u | ((cp >> 12u) & 0x3fu));
        *out++ = (char)(0x80u | ((cp >> 6u) & 0x3fu));
        *out++ = (char)(0x80u | (cp & 0x3fu));
    }
    return out;
}

char *melodica_json_string_dup(const MelodicaJsonDoc *doc, const size_t token) {
    if (doc == NULL || token >= doc->count ||
            doc->tokens[token].type != MELODICA_JSON_STRING) return NULL;
    const MelodicaJsonToken *t = &doc->tokens[token];
    const size_t raw_length = t->end - t->start;
    char *result = (char *)malloc(raw_length + 1u);
    if (result == NULL) return NULL;
    char *out = result;
    size_t i = t->start;
    while (i < t->end) {
        const char c = doc->text[i++];
        if (c != '\\') {
            *out++ = c;
            continue;
        }
        if (i >= t->end) { free(result); return NULL; }
        const char esc = doc->text[i++];
        switch (esc) {
            case '"': *out++ = '"'; break;
            case '\\': *out++ = '\\'; break;
            case '/': *out++ = '/'; break;
            case 'b': *out++ = '\b'; break;
            case 'f': *out++ = '\f'; break;
            case 'n': *out++ = '\n'; break;
            case 'r': *out++ = '\r'; break;
            case 't': *out++ = '\t'; break;
            case 'u': {
                if (i + 4u > t->end) { free(result); return NULL; }
                unsigned cp;
                if (!read_u16(doc->text + i, &cp)) { free(result); return NULL; }
                i += 4u;
                if (cp >= 0xd800u && cp <= 0xdbffu) {
                    if (i + 6u > t->end || doc->text[i] != '\\' || doc->text[i + 1u] != 'u') {
                        free(result); return NULL;
                    }
                    unsigned low;
                    if (!read_u16(doc->text + i + 2u, &low) || low < 0xdc00u || low > 0xdfffu) {
                        free(result); return NULL;
                    }
                    i += 6u;
                    cp = 0x10000u + ((cp - 0xd800u) << 10u) + (low - 0xdc00u);
                } else if (cp >= 0xdc00u && cp <= 0xdfffu) {
                    free(result); return NULL;
                }
                out = write_utf8(out, cp);
                break;
            }
            default: free(result); return NULL;
        }
    }
    *out = '\0';
    return result;
}

int melodica_json_long(const MelodicaJsonDoc *doc, const size_t token, long *value) {
    if (doc == NULL || token >= doc->count || value == NULL ||
            doc->tokens[token].type != MELODICA_JSON_PRIMITIVE) return 0;
    const MelodicaJsonToken *t = &doc->tokens[token];
    const size_t length = t->end - t->start;
    if (length == 0u || length >= 64u) return 0;
    char buffer[64];
    memcpy(buffer, doc->text + t->start, length);
    buffer[length] = '\0';
    char *end = NULL;
    errno = 0;
    const long parsed = strtol(buffer, &end, 10);
    if (errno != 0 || end == buffer || *end != '\0') return 0;
    *value = parsed;
    return 1;
}

int melodica_json_bool(const MelodicaJsonDoc *doc, const size_t token, int *value) {
    if (doc == NULL || token >= doc->count || value == NULL ||
            doc->tokens[token].type != MELODICA_JSON_PRIMITIVE) return 0;
    if (token_raw_is(doc, token, "true")) { *value = 1; return 1; }
    if (token_raw_is(doc, token, "false")) { *value = 0; return 1; }
    return 0;
}
