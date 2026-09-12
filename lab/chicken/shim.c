#include "../abi.h"
#include <chicken.h>

extern int chicken_lab_find_string(void *json, size_t json_len,
                                   void *key, size_t key_len,
                                   size_t *value_offset, size_t *value_len);

int lab_find_string(const char *json, size_t json_len,
                    const char *key, size_t key_len,
                    size_t *value_offset, size_t *value_len) {
    static int initialized;
    if (!initialized) {
        (void)CHICKEN_run(C_toplevel);
        initialized = 1;
    }
    return chicken_lab_find_string((void *)json, json_len,
                                   (void *)key, key_len,
                                   value_offset, value_len);
}
