#ifndef MELODICA_LANGUAGE_LAB_ABI_H
#define MELODICA_LANGUAGE_LAB_ABI_H

#include <stddef.h>

#define LAB_OK 0
#define LAB_NOT_FOUND 1
#define LAB_INVALID_JSON 2
#define LAB_BAD_ARGUMENT 4

int lab_find_string(const char *json, size_t json_len,
                    const char *key, size_t key_len,
                    size_t *value_offset, size_t *value_len);

#endif
