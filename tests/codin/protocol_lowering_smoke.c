#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

struct Node { struct Node *next; uint32_t values[3]; };
struct Alignment { char prefix; struct Node value; };
extern uint32_t compiler_protocol_fixture(void);

int main(void) {
    /* Return operands must be copied before the deferred free. The loop's
     * continue must still execute its post statement. Layout is measured here. */
    const uint32_t expected = 17u + 5u + 29u + 13u +
        (uint32_t)offsetof(struct Node, values) + (uint32_t)offsetof(struct Alignment, value);
    assert(compiler_protocol_fixture() == expected);
    puts("Codin protocol lowering: pointers, arrays, defaults, tuple returns, defer, continue and layout passed");
    return 0;
}
