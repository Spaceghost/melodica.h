#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_slice_string(void);

int main(void) {
    const uint32_t got = melodica_test_slice_string();
    if (got != 110) {
        fprintf(stderr, "slice/string smoke mismatch: got %u, expected 110\n", got);
        return 1;
    }
    puts("codin slice/string smoke: ok");
    return 0;
}
