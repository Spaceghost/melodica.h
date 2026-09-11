#ifndef MELODICA_HEADER
#define MELODICA_HEADER "dist/melodica.h"
#endif
#include MELODICA_HEADER

static_assert(MELODICA_VERSION_MAJOR == 0, "header visible from C++");
int main() { return melodica_version() == MELODICA_VERSION ? 0 : 1; }
