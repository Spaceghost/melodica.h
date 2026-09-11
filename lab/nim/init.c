#include "../abi.h"

extern void NimMain(void);
extern int nim_lab_find_string(const char *json, size_t json_len,
                               const char *key, size_t key_len,
                               size_t *value_offset, size_t *value_len);

int lab_find_string(const char *json, size_t json_len,
                    const char *key, size_t key_len,
                    size_t *value_offset, size_t *value_len) {
    static int initialized = 0;
    if (!initialized) {
        NimMain();
        initialized = 1;
    }
    return nim_lab_find_string(json, json_len, key, key_len,
                               value_offset, value_len);
}
