#include <stdint.h>
#include <stdio.h>

uint32_t melodica_test_enum_value(void);

int main(void) {
    const uint32_t got = melodica_test_enum_value();
    if (got != 9) {
        fprintf(stderr, "enum smoke mismatch: got %u, expected 9\n", got);
        return 1;
    }
    puts("codin enum smoke: ok");
    return 0;
}
