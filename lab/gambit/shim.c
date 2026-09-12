#include "abi.h"

#include <gambit.h>
#include <limits.h>
#include <stddef.h>
#include <stdlib.h>

extern int gambit_lab_find_string_impl(char *json, unsigned long json_len,
                                       char *key, unsigned long key_len,
                                       void *out_off, void *out_len);

#define SCHEME_LIBRARY_LINKER ___LNK_gambitlink__

___BEGIN_C_LINKAGE
extern ___mod_or_lnk SCHEME_LIBRARY_LINKER(___global_state);
___END_C_LINKAGE

static int gambit_ready;

static void gambit_shutdown(void) {
    if (gambit_ready) {
        ___cleanup();
        gambit_ready = 0;
    }
}

static void gambit_startup(void) {
    if (!gambit_ready) {
        ___setup_params_struct params;
        ___setup_params_reset(&params);
        params.version = ___VERSION;
        params.linker = SCHEME_LIBRARY_LINKER;
        ___setup(&params);
        gambit_ready = 1;
        atexit(gambit_shutdown);
    }
}

int lab_find_string(const char *json, size_t json_len,
                    const char *key, size_t key_len,
                    size_t *value_offset, size_t *value_len) {
    if (!json || !key || !value_offset || !value_len)
        return LAB_BAD_ARGUMENT;
    if (json_len > ULONG_MAX || key_len > ULONG_MAX)
        return LAB_BAD_ARGUMENT;

    gambit_startup();
    return gambit_lab_find_string_impl((char *)json, (unsigned long)json_len,
                                       (char *)key, (unsigned long)key_len,
                                       value_offset, value_len);
}
