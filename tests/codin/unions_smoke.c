#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_unions(void);

int main(void) {
    const uint32_t got = melodica_test_unions();
    if (got != 49) {
        fprintf(stderr, "union smoke mismatch: got %u, expected 49\n", got);
        return 1;
    }
    puts("codin union smoke: ok");
    return 0;
}
