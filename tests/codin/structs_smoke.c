#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_pair_sum(uint8_t a, uint32_t b);

int main(void) {
    const uint32_t got = melodica_test_pair_sum(7, 1000);
    if (got != 1007) {
        fprintf(stderr, "struct smoke mismatch: got %u, expected 1007\n", got);
        return 1;
    }
    puts("codin struct smoke: ok");
    return 0;
}
