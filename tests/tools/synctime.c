/* Prints a Pandora-style syncTime (hex Blowfish ciphertext under the
 * partner's incoming key) for a fixed timestamp, so tests can feed a canned
 * auth.partnerLogin response to the module without touching the network.
 * Build (any C compiler, or emcc + node):
 *   cc -Ivendor/melodica.h/compat tests/tools/synctime.c \
 *      vendor/melodica.h/compat/crypt.c vendor/melodica.h/compat/blowfish.c -o synctime */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "blowfish.h"
#include "crypt.h"

int main(int argc, char **argv) {
    const char *inkey = "R=U!LH$O2B#";
    const char *stamp = argc > 1 ? argv[1] : "1762300000";
    MelodicaBlowfish ctx;
    if (!melodica_blowfish_init(&ctx, inkey, strlen(inkey))) return 1;
    char plain[64];
    snprintf(plain, sizeof(plain), "XXXX%s", stamp);   /* Pandora prefixes 4 junk bytes */
    char *hex = melodica_piano_encrypt_string(&ctx, plain);
    if (hex == NULL) return 1;
    printf("%s\n", hex);
    free(hex);
    return 0;
}
