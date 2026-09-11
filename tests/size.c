#ifndef MELODICA_HEADER
#define MELODICA_HEADER "dist/melodica.h"
#endif
#define MELODICA_IMPLEMENTATION
#include MELODICA_HEADER

/* Keep a reference from an otherwise empty translation unit. */
unsigned melodica_size_anchor(void) {
  return melodica_version();
}
