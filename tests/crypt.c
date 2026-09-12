#include "blowfish.h"
#include "crypt.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    MelodicaBlowfish ctx;
    assert(melodica_blowfish_init(&ctx, "abcdefgh", 8u));

    char *encrypted = melodica_piano_encrypt_string(&ctx, "hello");
    assert(encrypted != NULL);
    assert(strcmp(encrypted, "936f264832cfda48") == 0);

    size_t size = 0u;
    char *plain = melodica_piano_decrypt_string(&ctx, encrypted, &size);
    assert(plain != NULL);
    assert(size == 8u);
    assert(memcmp(plain, "hello\0\0\0", 8u) == 0);

    free(plain);
    free(encrypted);
    melodica_blowfish_clear(&ctx);
    return 0;
}
