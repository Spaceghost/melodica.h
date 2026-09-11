#include "../../dist/melodica.h"

#include <stdio.h>

int main(void) {
    char body[128];
    size_t written = 0;

    if (melodica_version() != MELODICA_VERSION) return 1;
    if (melodica_narrative_body("station", 7, "music", 5,
                                body, sizeof body, &written) != MELODICA_OK) return 2;

    printf("Objective-C: %.*s\n", (int)written, body);
    return 0;
}
