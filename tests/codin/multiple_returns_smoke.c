#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_multiple_returns(void);

int main(void) {
    const uint32_t got = melodica_test_multiple_returns();
    if (got != 43) {
        fprintf(stderr, "multiple-return smoke mismatch: got %u, expected 43\n", got);
        return 1;
    }
    puts("codin multiple-return smoke: ok");
    return 0;
}
