#include "../../dist/melodica.h"

#include <stdio.h>
#include <string.h>

int main(void) {
    char body[128];
    size_t written = 0;
    const char expected[] = "{\"pageSize\":25,\"startIndex\":0}";

    if (melodica_version() != MELODICA_VERSION) return 1;
    if (melodica_stations_body(25, 0, body, sizeof body, &written) != MELODICA_OK) return 2;
    if (written != sizeof expected - 1 || memcmp(body, expected, written) != 0) return 3;

    printf("C: %.*s\n", (int)written, body);
    return 0;
}
