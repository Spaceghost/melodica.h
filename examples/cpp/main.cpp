#include "../../dist/melodica.h"

#include <iostream>
#include <string_view>

int main() {
    char body[128]{};
    size_t written = 0;

    if (melodica_version() != MELODICA_VERSION) return 1;
    if (melodica_tired_body("track-token", 11, body, sizeof body, &written) != MELODICA_OK) return 2;

    std::cout << "C++: " << std::string_view(body, written) << '\n';
    return 0;
}
