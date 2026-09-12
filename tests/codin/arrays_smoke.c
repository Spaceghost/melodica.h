#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_array_sum(void);

int main(void) {
    const uint32_t got = melodica_test_array_sum();
    if (got != 10) {
        fprintf(stderr, "array smoke mismatch: got %u, expected 10\n", got);
        return 1;
    }
    puts("codin array smoke: ok");
    return 0;
}
