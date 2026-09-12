#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_defer(void);

int main(void) {
    const uint32_t got = melodica_test_defer();
    if (got != 19) {
        fprintf(stderr, "defer smoke mismatch: got %u, expected 19\n", got);
        return 1;
    }
    puts("codin defer smoke: ok");
    return 0;
}
